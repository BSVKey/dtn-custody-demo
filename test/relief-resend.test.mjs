// Lost-chunk resend and device key revocation in the field pilot kit, through the real node
// daemons over an in-memory network with a controllable clock and a lossy link.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { provision, revoke } from "../relief/kit/provision.mjs";
import { startNode } from "../relief/kit/node.mjs";
import { memoryNetwork } from "../relief/kit/lib/transport.mjs";
import { makeClinic, keyAt } from "../relief/kit/lib/roles.mjs";
import { importKeypair, genKeypair } from "../agent/lib/keys.mjs";
import { signRecord } from "../agent/lib/receipt.mjs";

const deployment = JSON.parse(readFileSync(new URL("../relief/kit/deployment.example.json", import.meta.url), "utf8"));
const attachment = Buffer.alloc(6 * 1024, 7); // 6 chunks of 1 KB plus the header

// A field network whose courier -> village link can drop or alter chosen frames.
async function field({ configs: given, drop = () => false, alter = (b) => b } = {}) {
  const { configs } = given ?? provision({ ...deployment, resendAfterMs: 60_000, maxResends: 3 });
  delete configs["district-hub"].dashboard;
  let clock = Date.parse("2026-10-19T08:00:00Z");
  const now = () => clock;
  const net = memoryNetwork();
  const root = mkdtempSync(join(tmpdir(), "relief-resend-"));
  const nodes = {};
  for (const name of ["district-hub", "village-kalo", "courier-07", "clinic-north"]) {
    const c = configs[name];
    let t = net.transport(c.eid);
    if (name === "courier-07") {
      const send = t.send;
      t = { ...t, send: (to, buf) => {
        if (to !== configs["village-kalo"].eid) return send(to, buf);
        const f = JSON.parse(buf);
        if (drop(f)) return Promise.resolve();
        return send(to, alter(buf, f));
      } };
    }
    nodes[name] = await startNode(c, { dataDir: join(root, name), transport: t, pollMs: 3600_000, now });
  }
  after(() => Object.values(nodes).forEach((n) => n.stop()));
  const hub = nodes["district-hub"];
  return {
    configs, nodes, hub: hub.hub, root, net,
    advance: async (ms) => { clock += ms; await hub.tick(); await net.settle(); },
    send: async (name, bytes) => {
      writeFileSync(join(root, "clinic-north", "outbox", name), bytes);
      await nodes["clinic-north"].poll(); await nodes["clinic-north"].poll(); await net.settle();
    },
  };
}

test("resend: chunks lost on the way are requested back from the clinic and the report completes", async () => {
  const lost = new Set();
  let first = true;
  const f = await field({ drop: (fr) => fr.kind === "chunk" && (fr.bundle.index === 2 || fr.bundle.index === 4) && first && !lost.has(fr.bundle.index) && lost.add(fr.bundle.index) });
  await f.send("scan.bin", attachment);
  first = false;
  const id = f.hub.state().reports[0].payloadId;
  assert.equal(f.hub.state().reports[0].status, "in_transit");
  assert.equal(f.hub.state().reports[0].received, f.hub.state().reports[0].chunkCount - 2);

  await f.advance(30_000);                       // too soon: no request yet
  assert.equal(f.hub.state().resendRequests, 0);
  await f.advance(31_000);                       // a minute after the last frame: ask
  const r = f.hub.report(id);
  assert.equal(r.status, "verified");
  assert.equal(r.resends, 1);
  assert.equal(f.hub.state().resendRequests, 1);
  assert.equal(f.nodes["village-kalo"].relay.returned, 1, "the request went back through the village relay");
  assert.equal(f.nodes["courier-07"].relay.returned, 1, "and through the courier");
  assert.deepEqual(r.bytes, Buffer.from(attachment));
});

test("resend: a chunk altered in transit is refused, re-requested, and the genuine copy completes the report", async () => {
  let altered = false;
  const f = await field({ alter: (buf, fr) => {
    if (altered || fr.kind !== "chunk" || fr.bundle.index !== 1) return buf;
    altered = true;
    const x = Buffer.from(fr.bundle.bytesB64, "base64"); x[0] ^= 1; fr.bundle.bytesB64 = x.toString("base64");
    return Buffer.from(JSON.stringify(fr));
  } });
  await f.send("scan.bin", attachment);
  const id = f.hub.state().reports[0].payloadId;
  assert.equal(f.hub.state().refusals[0].reason, "leaf_hash_mismatch");
  await f.advance(61_000);
  assert.equal(f.hub.report(id).status, "verified");
});

test("resend: a lost manifest is requested too", async () => {
  let dropped = false;
  const f = await field({ drop: (fr) => fr.kind === "manifest" && !dropped && (dropped = true) });
  await f.send("r.json", Buffer.from('{"patientsSeen":3}'));
  const id = f.hub.state().reports[0].payloadId;
  assert.equal(f.hub.state().reports[0].chunkCount, null);
  await f.advance(61_000);
  assert.equal(f.hub.report(id).status, "verified");
});

test("resend: requests back off and stop after maxResends; a clinic ignores requests not signed by its hub", async () => {
  const f = await field({ drop: (fr) => fr.kind === "chunk" && fr.bundle.index === 3 }); // that chunk never gets through
  await f.send("scan.bin", attachment);
  for (const step of [61_000, 61_000, 121_000, 241_000, 481_000, 961_000]) await f.advance(step);
  assert.equal(f.hub.state().resendRequests, 3, "maxResends is 3");
  assert.equal(f.hub.state().reports[0].status, "in_transit");

  const cc = f.configs["clinic-north"];
  const clinic = makeClinic({ kp: importKeypair(cc.sign), eid: cc.eid, next: "x", hubEncPub: cc.hubEncPub, hubSignPub: cc.hubSignPub });
  const forged = signRecord(genKeypair(), { kind: "resend/1", payloadId: "p", clinic: cc.eid, manifest: true, indexes: [0], seq: 0, at: 0 });
  const r = await clinic.onFrame({ send: async () => assert.fail("must not send") }, Buffer.from(JSON.stringify({ v: 1, kind: "resend", request: forged })));
  assert.equal(r.reason, "not_signed_by_hub");
});

test("revocation: a lost courier's old key is refused from then on, the new device carries on, earlier work still counts", async () => {
  const base = provision({ ...deployment, resendAfterMs: 60_000, maxResends: 3 });
  const f = await field({ configs: base });
  await f.send("before.json", Buffer.from('{"patientsSeen":1}'));
  const before = f.hub.state().reports[0];
  assert.equal(before.status, "verified");

  // The courier's phone is lost. Revoke its key; the hub gets the updated directory.
  const r = revoke(base, "courier-07", { reason: "phone lost", at: Date.parse("2026-10-19T08:05:00Z") });
  f.hub.setDirectory(r.configs["district-hub"].directory);
  await f.advance(5 * 60_000);

  // Whoever has the old phone keeps relaying: refused, not paid.
  await f.send("after.json", Buffer.from('{"patientsSeen":2}'));
  const st = f.hub.state();
  const late = st.reports.find((x) => x.payloadId !== before.payloadId);
  assert.equal(late.status, "in_transit");
  assert.ok(st.refusals.some((x) => x.reason === "key_revoked" && x.claimedBy === "dtn://courier-07.dtn/"));
  assert.equal(st.payouts["dtn://courier-07.dtn/"].bundles, 1, "only the bundle carried before the loss is paid");
  assert.equal(st.revoked[0].reason, "phone lost");

  // The replacement phone (new key, no memory of the report) comes online; the hub asks for
  // the refused chunk again, the request follows the route back, and the report completes.
  f.nodes["courier-07"].stop();
  f.nodes["courier-07"] = await startNode(r.configs["courier-07"], { dataDir: join(f.root, "courier-07-new"), transport: f.net.transport("dtn://courier-07.dtn/"), pollMs: 3600_000 });
  await f.advance(61_000);
  assert.equal(f.hub.report(late.payloadId).status, "verified");
  assert.equal(f.hub.state().payouts["dtn://courier-07.dtn/"].bundles, 2, "the new device is paid for what it carried");

  // A restarted hub replays its log and still accepts the work done before the revocation.
  const net2 = memoryNetwork();
  const hubCfg = r.configs["district-hub"];
  const again = await startNode({ ...hubCfg, dashboard: undefined }, { dataDir: join(f.root, "district-hub"), transport: net2.transport(hubCfg.eid) });
  after(() => again.stop());
  assert.equal(again.hub.report(before.payloadId).status, "verified");

  // The key that was valid at each moment.
  const dir = r.configs["district-hub"].directory;
  assert.equal(keyAt(dir.relays, dir.revoked, "dtn://courier-07.dtn/", r.record.revokedAt - 1), base.configs["courier-07"].sign.pub);
  assert.equal(keyAt(dir.relays, dir.revoked, "dtn://courier-07.dtn/", r.record.revokedAt), r.configs["courier-07"].sign.pub);
  assert.throws(() => revoke(base, "district-hub"), /cannot be revoked/);
});

test("revocation: a running hub picks up a revocation written into its config file", async () => {
  const base = provision(deployment);
  const root = mkdtempSync(join(tmpdir(), "relief-reload-"));
  const cfgPath = join(root, "district-hub.json");
  const hubCfg = { ...base.configs["district-hub"], dashboard: undefined };
  writeFileSync(cfgPath, JSON.stringify(hubCfg));
  const net = memoryNetwork();
  const n = await startNode(hubCfg, { dataDir: join(root, "hub"), transport: net.transport(hubCfg.eid), pollMs: 3600_000, configPath: cfgPath });
  after(() => n.stop());
  assert.deepEqual(n.hub.state().revoked, []);
  const r = revoke(base, "courier-07", { reason: "phone lost" });
  await new Promise((res) => setTimeout(res, 20)); // a later mtime
  writeFileSync(cfgPath, JSON.stringify(r.configs["district-hub"]));
  await n.tick();
  assert.deepEqual(n.hub.state().revoked.map((x) => [x.eid, x.reason]), [["dtn://courier-07.dtn/", "phone lost"]]);
});
