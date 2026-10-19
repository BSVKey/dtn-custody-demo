// The field pilot kit (relief/kit): provisioning, the node daemons end to end over an
// in-memory network (clinic outbox to hub inbox), hub restart from its frame log, the
// dashboard API, and the refusals.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readdirSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { provision } from "../relief/kit/provision.mjs";
import { startNode } from "../relief/kit/node.mjs";
import { memoryNetwork } from "../relief/kit/lib/transport.mjs";
import { makeHub, makeRelayNode, makeClinic } from "../relief/kit/lib/roles.mjs";
import { importKeypair, genKeypair } from "../agent/lib/keys.mjs";
import { makeRelay } from "../agent/relay.mjs";
import { signRecord } from "../agent/lib/receipt.mjs";
import { sealTo, openAt, genEncKeypair } from "../relief/kit/lib/seal.mjs";

const deployment = JSON.parse(readFileSync(new URL("../relief/kit/deployment.example.json", import.meta.url), "utf8"));
const report = readFileSync(new URL("../relief/kit/samples/clinic-river-report.json", import.meta.url));

async function field({ dash = false } = {}) {
  const { directory, configs } = provision(deployment);
  if (!dash) delete configs["district-hub"].dashboard; else configs["district-hub"].dashboard = { host: "127.0.0.1", port: 0 };
  const net = memoryNetwork();
  const root = mkdtempSync(join(tmpdir(), "relief-kit-"));
  const nodes = {};
  for (const name of ["district-hub", "village-kalo", "courier-07", "clinic-north", "clinic-river"]) {
    const c = configs[name];
    nodes[name] = await startNode(c, { dataDir: join(root, name), transport: net.transport(c.eid), pollMs: 3600_000 });
  }
  const drop = async (clinic, name, bytes) => {
    writeFileSync(join(root, clinic, "outbox", name), bytes);
    await nodes[clinic].poll(); await nodes[clinic].poll(); // size seen, then stable: send
    await net.settle();
  };
  const stop = () => Object.values(nodes).forEach((n) => n.stop());
  after(stop); // also on a failed assertion, so no node keeps the process alive
  return { directory, configs, net, root, nodes, drop, stop };
}

test("kit: provision gives every node its key and the hub the directory; refuses a bad deployment", () => {
  const { directory, configs } = provision(deployment);
  assert.equal(Object.keys(configs).length, 5);
  assert.equal(Object.keys(directory.clinics).length, 2);
  assert.equal(Object.keys(directory.relays).length, 2);
  assert.ok(configs["district-hub"].encPriv && !configs["courier-07"].encPriv, "only the hub can decrypt");
  assert.ok(!JSON.stringify(directory).includes("PRIVATE KEY"), "directory is public");
  assert.throws(() => provision({ nodes: deployment.nodes.filter((n) => n.role !== "hub") }), /exactly one hub/);
  assert.throws(() => provision({ nodes: [...deployment.nodes, { ...deployment.nodes[0] }] }), /duplicate/);
});

test("kit: a file dropped in a clinic outbox comes out decrypted and verified at the hub", async () => {
  const f = await field();
  await f.drop("clinic-river", "report.json", report);
  const st = f.nodes["district-hub"].hub.state();
  const r = st.reports[0];
  assert.equal(r.status, "verified");
  assert.deepEqual(r.route, ["dtn://clinic-river.dtn/", "dtn://courier-07.dtn/", "dtn://village-kalo.dtn/", "dtn://district-hub.dtn/"]);
  assert.equal(r.summary.urgent[0], "suspected cholera cluster: 6 cases");
  const inbox = join(f.root, "district-hub", "inbox");
  const dir = join(inbox, readdirSync(inbox)[0]);
  assert.deepEqual(readFileSync(join(dir, "report.json")), report);
  assert.equal(JSON.parse(readFileSync(join(dir, "evidence.json"), "utf8")).status, "verified");
  assert.ok(existsSync(join(f.root, "clinic-river", "sent", "report.json.receipt.json")));
  assert.equal(readFileSync(join(f.root, "courier-07", "claims.jsonl"), "utf8").trim().split("\n").length, r.chunkCount);
  assert.deepEqual(st.payouts["dtn://courier-07.dtn/"], { bundles: r.chunkCount, sats: r.chunkCount * 50 });
  assert.deepEqual(st.refusals, []);
  f.stop();
});

test("kit: a restarted hub rebuilds its state from the frame log", async () => {
  const f = await field();
  await f.drop("clinic-north", "a.json", report);
  await f.drop("clinic-river", "b.json", report);
  const before = f.nodes["district-hub"].hub.state();
  f.nodes["district-hub"].stop();
  const net2 = memoryNetwork();
  const again = await startNode(f.configs["district-hub"], { dataDir: join(f.root, "district-hub"), transport: net2.transport("dtn://district-hub.dtn/") });
  after(() => again.stop());
  const restored = again.hub.state();
  assert.equal(restored.reports.filter((r) => r.status === "verified").length, 2);
  assert.deepEqual(restored.payouts, before.payouts);
  again.stop(); f.stop();
});

test("kit: the dashboard serves the page and the state", async () => {
  const f = await field({ dash: true });
  await f.drop("clinic-north", "report.json", report);
  const port = f.nodes["district-hub"].dashboard.port;
  const html = await (await fetch(`http://127.0.0.1:${port}/`)).text();
  assert.match(html, /kalo-district-pilot/);
  const st = await (await fetch(`http://127.0.0.1:${port}/api/state`)).json();
  assert.equal(st.reports[0].status, "verified");
  assert.equal(st.reports[0].bytes, undefined, "raw report bytes are not in the API");
  f.stop();
});

test("kit: tampered chunk, impostor relay, unknown clinic and wrong decryption key are refused", async () => {
  const { directory, configs } = provision(deployment);
  const hc = configs["district-hub"];
  const hub = makeHub({ kp: importKeypair(hc.sign), eid: hc.eid, encPriv: hc.encPriv, directory: hc.directory });
  const frames = [];
  const net = memoryNetwork();
  const t = net.transport("tap"); t.onFrame((b) => frames.push(b));
  const cc = configs["clinic-north"];
  const clinic = makeClinic({ kp: importKeypair(cc.sign), eid: cc.eid, next: "tap", hubEncPub: hc.hubEncPub, chunkSize: 128 });
  const sent = await clinic.sendFile(t, { name: "r.json", bytes: report });
  await net.settle();
  // Carry the frames through the two real relays.
  const relay = (name) => makeRelayNode({ kp: importKeypair(configs[name].sign), eid: configs[name].eid, next: "out" });
  const pass = async (node, bufs) => { const out = []; const n2 = memoryNetwork(); const o = n2.transport("out"); o.onFrame((b) => out.push(b)); const me = n2.transport("me"); for (const b of bufs) await node.onFrame(me, b); await n2.settle(); return out; };
  const relayed = await pass(relay("village-kalo"), await pass(relay("courier-07"), frames));
  const [manifest, ...chunks] = relayed;

  // 1. A tampered copy of chunk 0 arrives first: refused and dropped; the genuine copy still verifies.
  const bad = JSON.parse(chunks[0]); const bytes = Buffer.from(bad.bundle.bytesB64, "base64"); bytes[3] ^= 1; bad.bundle.bytesB64 = bytes.toString("base64");
  hub.ingest(manifest); hub.ingest(Buffer.from(JSON.stringify(bad)));
  for (const c of chunks) hub.ingest(c);
  const st = hub.state();
  assert.equal(hub.report(sent.payloadId).status, "verified");
  assert.deepEqual(st.refusals.map((r) => r.reason), ["leaf_hash_mismatch"]);

  // 2. An impostor re-signs a chunk as courier-07: refused, and courier-07 is not paid twice.
  const hub2 = makeHub({ kp: importKeypair(hc.sign), eid: hc.eid, encPriv: hc.encPriv, directory: hc.directory });
  const forged = JSON.parse(chunks[1]);
  forged.custody[0] = makeRelay(genKeypair(), "dtn://courier-07.dtn/").stamp(forged.bundle, cc.eid, 1, 1);
  hub2.ingest(manifest); hub2.ingest(Buffer.from(JSON.stringify(forged)));
  assert.equal(hub2.state().refusals[0].reason, "signer_not_pinned_hop_key");
  assert.equal(hub2.state().refusals[0].claimedBy, "dtn://courier-07.dtn/");

  // 3. A clinic the hub does not know: refused, nothing kept.
  const hub3 = makeHub({ kp: importKeypair(hc.sign), eid: hc.eid, encPriv: hc.encPriv, directory: { ...hc.directory, clinics: {} } });
  hub3.ingest(manifest);
  assert.equal(hub3.state().refusals[0].reason, "unknown_clinic");
  assert.equal(hub3.report(sent.payloadId), null);

  // 3b. A forged manifest for the same report id sent first does not block the genuine one.
  const hub4 = makeHub({ kp: importKeypair(hc.sign), eid: hc.eid, encPriv: hc.encPriv, directory: hc.directory });
  const real = JSON.parse(manifest);
  const { claimId, sig, signerPub, ...content } = real.manifest;
  const forgedManifest = { ...real, manifest: signRecord(genKeypair(), { ...content, root: "00".repeat(32) }) };
  hub4.ingest(Buffer.from(JSON.stringify(forgedManifest)));
  hub4.ingest(manifest);
  for (const c of chunks) hub4.ingest(c);
  assert.equal(hub4.state().refusals[0].reason, "signer_not_pinned_source_key");
  assert.equal(hub4.report(sent.payloadId).status, "verified");

  // 4. Sealed data opens only with the hub key and only under its own payloadId.
  const k = genEncKeypair(), other = genEncKeypair();
  const s = sealTo(k.pub, Buffer.from("x"), "id-1");
  assert.equal(openAt(k.priv, s, "id-1").toString(), "x");
  assert.throws(() => openAt(other.priv, s, "id-1"));
  assert.throws(() => openAt(k.priv, s, "id-2"));
});
