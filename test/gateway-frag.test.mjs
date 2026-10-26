import test from "node:test";
import assert from "node:assert/strict";
import dgram from "node:dgram";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { Gateway, makeBundles, parseEid } from "../gateway/gateway.mjs";
import { decodeBundle, encodeBundle, payloadOf, BUNDLE_FLAG } from "../transport/bpv7/bundle.mjs";
import { genKeypair } from "../agent/lib/keys.mjs";

const tmp = () => mkdtempSync(join(tmpdir(), "gw-"));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 10000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await fn()) return true; await wait(25); } return false; };
const big = (n) => { const b = Buffer.alloc(n); for (let i = 0; i < n; i++) b[i] = (i * 31 + 7) & 0xff; return b; };
const sha = (b) => createHash("sha256").update(b).digest("hex");

test("EIDs: ipn and dtn schemes parse; anything else is refused", () => {
  assert.deepEqual(parseEid("ipn:2.1"), { scheme: "ipn", node: "2", service: "1" });
  assert.deepEqual(parseEid("dtn://ground-b/telemetry"), { scheme: "dtn", node: "ground-b", service: "telemetry" });
  assert.throws(() => parseEid("http://x/"));
  assert.throws(() => parseEid("dtn:none"));
});

test("fragmentation: a large payload becomes BPv7 fragments with offsets, one shared creation time, and the receipt in each", () => {
  const kp = genKeypair();
  const payload = big(2500000);
  const frags = makeBundles({ payload, source: "ipn:1.1", dest: "ipn:2.1", lifetimeMs: 60000, seq: 4, keypair: kp, gateway: "ipn:1.0", from: "http:test", maxPayload: 1000000 }).map(decodeBundle);
  assert.equal(frags.length, 3);
  assert.deepEqual(frags.map((f) => f.primary.fragmentOffset), [0, 1000000, 2000000]);
  assert.ok(frags.every((f) => f.primary.flags & BUNDLE_FLAG.IS_FRAGMENT && f.primary.totalAduLength === 2500000));
  assert.ok(frags.every((f) => f.primary.created[0] === frags[0].primary.created[0] && f.primary.created[1] === 4));
  assert.ok(frags.every((f) => f.blocks.some((b) => b.type === 226)), "ingress receipt replicated into every fragment");
  assert.equal(Buffer.concat(frags.map(payloadOf)).equals(payload), true);
  assert.equal(makeBundles({ payload: Buffer.from("small"), source: "ipn:1.1", dest: "ipn:2.1", lifetimeMs: 1, seq: 0, maxPayload: 1000000 }).length, 1);
});

test("reassembly: fragments in any order rebuild the payload once, and the receipt checks against the whole", () => {
  const kp = genKeypair();
  const gw = new Gateway({ node: 2, spoolDir: tmp(), pinnedGateways: { "ipn:1.0": kp.pub }, requireIngressReceipt: true });
  const delivered = [];
  gw.on("delivered", (d) => delivered.push(d));
  const payload = big(3500000);
  const frags = makeBundles({ payload, source: "ipn:1.1", dest: "ipn:2.1", lifetimeMs: 60000, seq: 0, keypair: kp, gateway: "ipn:1.0", from: "x", maxPayload: 1000000 });
  for (const f of [...frags].reverse()) gw.fromDtn(f, "test");
  gw.fromDtn(frags[1], "test");                       // a duplicate after completion starts a new set
  assert.equal(delivered.length, 1);
  assert.equal(sha(delivered[0].payload), sha(payload));
  assert.equal(delivered[0].ingress.ok, true);
  assert.equal(gw.stats.reassembled, 1);
});

test("reassembly rejects inconsistent or out-of-range fragments and respects its memory cap", () => {
  const gw = new Gateway({ node: 2, spoolDir: tmp(), maxReassemblyBytes: 1500000 });
  const mk = (offset, total, len) => encodeBundle({
    primary: { flags: BUNDLE_FLAG.IS_FRAGMENT, crcType: 2, dest: "ipn:2.1", source: "ipn:1.1", reportTo: "dtn:none", created: [1000, 1], lifetime: 60000, fragmentOffset: offset, totalAduLength: total },
    blocks: [{ type: 1, number: 1, flags: 0, crcType: 2, data: Buffer.alloc(len) }],
  });
  gw.fromDtn(mk(900, 1000, 200), "t");               // runs past the total length
  assert.equal(gw.stats.rejected, 1);
  gw.fromDtn(mk(0, 5000000, 1000000), "t");
  gw.fromDtn(mk(1000000, 5000000, 1000000), "t");     // would exceed the 1.5 MB cap
  assert.equal(gw.stats.rejected, 2);
  gw.fromDtn(mk(0, 999, 10), "t");                    // same identity, different total
  assert.equal(gw.stats.rejected, 3);
});

test("gateway pair: a 3.5 MB HTTP upload crosses as fragments and arrives whole", async () => {
  const kp = genKeypair();
  const gwB = await new Gateway({ node: 2, spoolDir: tmp(), listenPort: 0, pinnedGateways: { "ipn:1.0": kp.pub }, requireIngressReceipt: true }).start();
  const got = [];
  gwB.on("delivered", (d) => got.push(d));
  const gwA = await new Gateway({ node: 1, spoolDir: tmp(), keypair: kp, peer: { host: "127.0.0.1", port: gwB.dtnPort }, ipIngress: { http: { port: 0 } } }).start();
  const payload = big(3500000);
  const r = await fetch(`http://127.0.0.1:${gwA.httpPort}/bundles?dest=ipn:2.5`, { method: "POST", body: payload });
  const queued = (await r.json()).queued;
  assert.equal(queued.length, 4, "four fragments of at most 1 MB");
  assert.ok(await until(() => got.length === 1));
  assert.equal(sha(got[0].payload), sha(payload));
  assert.equal(got[0].ingress.ok, true);
  assert.equal(gwA.stats.toDtn, 4);
  await gwA.stop(); await gwB.stop();
});

test("dtn-scheme gateways: dtn://sat-a/ to dtn://ground-b/telemetry", async () => {
  const sink = dgram.createSocket("udp4");
  const got = [];
  sink.on("message", (m) => got.push(m.toString()));
  await new Promise((r) => sink.bind(0, "127.0.0.1", r));
  const gwB = await new Gateway({ nodeId: "dtn://ground-b/", spoolDir: tmp(), listenPort: 0, ipEgress: { telemetry: { udp: `127.0.0.1:${sink.address().port}` } } }).start();
  const seen = [];
  gwB.on("delivered", (d) => seen.push(d));
  const gwA = await new Gateway({ nodeId: "dtn://sat-a/", spoolDir: tmp(), peer: { host: "127.0.0.1", port: gwB.dtnPort }, ipIngress: { udp: [{ port: 0, dest: "dtn://ground-b/telemetry", source: "camera" }] } }).start();
  const s = dgram.createSocket("udp4");
  await new Promise((r) => s.send("frame over dtn scheme", gwA.udpPorts[0], "127.0.0.1", r));
  s.close();
  assert.ok(await until(() => got.length === 1));
  assert.equal(got[0], "frame over dtn scheme");
  assert.equal(seen[0].source, "dtn://sat-a/camera");
  await gwA.stop(); await gwB.stop(); sink.close();
});

test("HTTP ingress refuses bodies over its limit", async () => {
  const gw = await new Gateway({ node: 1, spoolDir: tmp(), ipIngress: { http: { port: 0, maxBytes: 1000 } } }).start();
  const r = await fetch(`http://127.0.0.1:${gw.httpPort}/bundles?dest=ipn:2.1`, { method: "POST", body: Buffer.alloc(5000) }).catch((e) => ({ status: "reset" }));
  assert.ok(r.status === 413 || r.status === "reset");
  assert.equal(gw.spool.size, 0);
  await gw.stop();
});
