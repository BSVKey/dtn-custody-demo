import test from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import dgram from "node:dgram";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect, listen, encodeContactHeader, Parser, MSG } from "../gateway/tcpcl4.mjs";
import { Gateway, makeBundle, verifyIngress } from "../gateway/gateway.mjs";
import { decodeBundle, encodeBundle, payloadOf, BLOCK } from "../transport/bpv7/bundle.mjs";
import { genKeypair } from "../agent/lib/keys.mjs";

const tmp = () => mkdtempSync(join(tmpdir(), "gw-"));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 8000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await fn()) return true; await wait(25); }
  return false;
}
function udpSink() {
  const got = [];
  const s = dgram.createSocket("udp4");
  s.on("message", (m) => got.push(m));
  return new Promise((r) => s.bind(0, "127.0.0.1", () => r({ got, port: s.address().port, close: () => s.close() })));
}
function udpSend(port, buf) {
  const s = dgram.createSocket("udp4");
  return new Promise((r) => s.send(buf, port, "127.0.0.1", () => { s.close(); r(); }));
}
const freePort = () => new Promise((r) => { const s = net.createServer(); s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => r(p)); }); });

test("TCPCLv4: handshake, segmentation to the peer's MRU, cumulative acks, both directions", async () => {
  const received = [];
  let serverSide;
  const server = await listen({ port: 0, host: "127.0.0.1", nodeId: "ipn:10.0", segmentMru: 1000 }, (s) => {
    serverSide = s;
    s.on("bundle", (b) => received.push(b));
  });
  const port = server.address().port;
  const client = await connect({ host: "127.0.0.1", port, nodeId: "ipn:1.0" });
  assert.equal(client.peer.nodeId, "ipn:10.0");
  assert.equal(client.peer.segmentMru, 1000);
  const big = Buffer.alloc(5500, 7); big[0] = 1; big[5499] = 9;
  const small = Buffer.from("hello");
  await client.send(big);           // resolves only after the final cumulative ack
  await client.send(small);
  assert.ok(await until(() => received.length === 2));
  assert.ok(received[0].equals(big), "5,500 bytes in six segments of at most 1,000 arrive intact");
  assert.ok(received[1].equals(small));
  const back = [];
  client.on("bundle", (b) => back.push(b));
  await serverSide.send(Buffer.from("downlink"));
  assert.ok(await until(() => back.length === 1));
  assert.equal(back[0].toString(), "downlink");
  await client.close();
  server.close();
});

test("TCPCLv4: a peer speaking another version is refused", async () => {
  const server = await listen({ port: 0, host: "127.0.0.1", nodeId: "ipn:10.0" }, () => {});
  const port = server.address().port;
  const reply = await new Promise((resolve) => {
    const s = net.connect({ host: "127.0.0.1", port }, () => s.write(Buffer.from([0x64, 0x74, 0x6e, 0x21, 3, 0])));
    const chunks = [];
    s.on("data", (d) => chunks.push(d));
    s.on("close", () => resolve(Buffer.concat(chunks)));
  });
  assert.equal(reply[0], MSG.SESS_TERM);
  assert.equal(reply[2], 2, "reason: version mismatch");
  server.close();
});

test("TCPCLv4 parser: rejects a segment above our MRU before buffering it", () => {
  const p = new Parser({ maxSegment: 100, maxTransfer: 1000 });
  p.push(encodeContactHeader());
  assert.equal(p.parse().kind, "contact");
  const seg = Buffer.alloc(1 + 1 + 8 + 4 + 8);
  seg[0] = MSG.XFER_SEGMENT; seg[1] = 0x03;
  seg.writeBigUInt64BE(10n ** 12n, 14);
  p.push(seg);
  assert.equal(p.parse().kind, "too_big");
});

test("ingress receipt: binds gateway, source and exact payload; any change is caught", () => {
  const kp = genKeypair();
  const bytes = makeBundle({ payload: Buffer.from("telemetry frame 42"), source: "ipn:1.1", dest: "ipn:2.1", lifetimeMs: 60000, seq: 0, keypair: kp, gateway: "ipn:1.0", from: "udp:10.0.0.5:7000" });
  const b = decodeBundle(bytes);
  const ok = verifyIngress(b, { "ipn:1.0": kp.pub });
  assert.equal(ok.ok, true);
  assert.equal(ok.receipt.from, "udp:10.0.0.5:7000");
  const tampered = { ...b, blocks: b.blocks.map((x) => (x.type === BLOCK.PAYLOAD ? { ...x, data: Buffer.from("telemetry frame 43") } : x)) };
  assert.equal(verifyIngress(decodeBundle(encodeBundle(tampered)), { "ipn:1.0": kp.pub }).reason, "payload_changed");
  assert.equal(verifyIngress(b, { "ipn:1.0": genKeypair().pub }).reason, "gateway_key_not_pinned");
});

test("gateway pair: UDP in on the IP side, BPv7 over TCPCLv4, UDP out on the far side", async () => {
  const kp = genKeypair();
  const sink = await udpSink();
  const gwB = await new Gateway({ node: 2, spoolDir: tmp(), listenPort: 0, ipEgress: { 1: { udp: `127.0.0.1:${sink.port}` } }, pinnedGateways: { "ipn:1.0": kp.pub }, requireIngressReceipt: true }).start();
  const delivered = [];
  gwB.on("delivered", (d) => delivered.push(d));
  const gwA = await new Gateway({ node: 1, spoolDir: tmp(), keypair: kp, peer: { host: "127.0.0.1", port: gwB.dtnPort }, ipIngress: { udp: [{ port: 0, dest: "ipn:2.1" }] } }).start();
  const frames = Array.from({ length: 20 }, (_, i) => Buffer.from(`frame ${i} ${"x".repeat(i * 50)}`));
  for (const f of frames) await udpSend(gwA.udpPorts[0], f);
  assert.ok(await until(() => sink.got.length === 20), `got ${sink.got.length}/20`);
  assert.deepEqual(sink.got.map(String), frames.map(String), "every frame arrives intact and in order");
  assert.ok(delivered.every((d) => d.ingress && d.ingress.ok && d.source === "ipn:1.1"));
  await gwA.stop(); await gwB.stop(); sink.close();
});

test("link outage and gateway restart: bundles wait on disk and drain in order when the peer returns", async () => {
  const kp = genKeypair();
  const dtnPort = await freePort();
  const spoolA = tmp();
  let gwA = await new Gateway({ node: 1, spoolDir: spoolA, keypair: kp, peer: { host: "127.0.0.1", port: dtnPort }, retryMs: 100, maxRetryMs: 200, ipIngress: { udp: [{ port: 0, dest: "ipn:2.1" }] } }).start();
  for (let i = 0; i < 5; i++) await udpSend(gwA.udpPorts[0], Buffer.from(`during outage ${i}`));
  assert.ok(await until(() => gwA.spool.size === 5), "five bundles spooled while the DTN side is unreachable");
  await gwA.stop();                                                  // gateway restarts mid-outage
  gwA = await new Gateway({ node: 1, spoolDir: spoolA, keypair: kp, peer: { host: "127.0.0.1", port: dtnPort }, retryMs: 100, maxRetryMs: 200, ipIngress: { udp: [{ port: 0, dest: "ipn:2.1" }] } }).start();
  assert.equal(gwA.spool.size, 5, "nothing lost across the restart");
  await udpSend(gwA.udpPorts[0], Buffer.from("after restart"));
  const sink = await udpSink();
  const gwB = await new Gateway({ node: 2, spoolDir: tmp(), listenPort: dtnPort, ipEgress: { 1: { udp: `127.0.0.1:${sink.port}` } }, pinnedGateways: { "ipn:1.0": kp.pub }, requireIngressReceipt: true }).start();
  assert.ok(await until(() => sink.got.length === 6, 10000), `got ${sink.got.length}/6`);
  assert.deepEqual(sink.got.map(String), ["during outage 0", "during outage 1", "during outage 2", "during outage 3", "during outage 4", "after restart"]);
  assert.equal(gwA.spool.size, 0);
  await gwA.stop(); await gwB.stop(); sink.close();
});

test("far gateway drops bundles without a valid ingress receipt when it requires one", async () => {
  const sink = await udpSink();
  const gwB = await new Gateway({ node: 2, spoolDir: tmp(), listenPort: 0, ipEgress: { 1: { udp: `127.0.0.1:${sink.port}` } }, pinnedGateways: { "ipn:1.0": genKeypair().pub }, requireIngressReceipt: true }).start();
  const gwA = await new Gateway({ node: 1, spoolDir: tmp(), keypair: genKeypair(), peer: { host: "127.0.0.1", port: gwB.dtnPort }, ipIngress: { udp: [{ port: 0, dest: "ipn:2.1" }] } }).start();
  await udpSend(gwA.udpPorts[0], Buffer.from("from an unpinned gateway"));
  assert.ok(await until(() => gwB.stats.rejected === 1));
  assert.equal(sink.got.length, 0);
  await gwA.stop(); await gwB.stop(); sink.close();
});

test("HTTP ingress and status", async () => {
  const sink = await udpSink();
  const gwB = await new Gateway({ node: 2, spoolDir: tmp(), listenPort: 0, ipEgress: { 7: { udp: `127.0.0.1:${sink.port}` } } }).start();
  const gwA = await new Gateway({ node: 1, spoolDir: tmp(), peer: { host: "127.0.0.1", port: gwB.dtnPort }, ipIngress: { http: { port: 0 } } }).start();
  const r = await fetch(`http://127.0.0.1:${gwA.httpPort}/bundles?dest=ipn:2.7`, { method: "POST", body: "image tile 3" });
  assert.equal(r.status, 202);
  assert.ok(await until(() => sink.got.length === 1));
  assert.equal(sink.got[0].toString(), "image tile 3");
  const st = await (await fetch(`http://127.0.0.1:${gwA.httpPort}/status`)).json();
  assert.equal(st.node, "ipn:1.0");
  assert.equal(st.stats.toDtn, 1);
  assert.equal((await fetch(`http://127.0.0.1:${gwA.httpPort}/bundles?dest=bad`, { method: "POST", body: "x" })).status, 400);
  await gwA.stop(); await gwB.stop(); sink.close();
});
