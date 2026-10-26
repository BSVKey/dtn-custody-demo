import test from "node:test";
import assert from "node:assert/strict";
import dgram from "node:dgram";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect, listen, sdnv, readSdnv } from "../gateway/tcpcl3.mjs";
import { Gateway } from "../gateway/gateway.mjs";

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 5000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await fn()) return true; await wait(20); } return false; };

test("SDNV: round trip and the RFC 6256 examples", () => {
  assert.deepEqual([...sdnv(0)], [0x00]);
  assert.deepEqual([...sdnv(0x7f)], [0x7f]);
  assert.deepEqual([...sdnv(0xabc)], [0x95, 0x3c]);
  assert.deepEqual([...sdnv(0x1234)], [0xa4, 0x34]);
  assert.deepEqual([...sdnv(0x4234)], [0x81, 0x84, 0x34]);
  for (const n of [1, 127, 128, 16383, 16384, 2 ** 32, 2 ** 40 + 5]) assert.equal(Number(readSdnv(sdnv(n), 0).value), n);
  assert.equal(readSdnv(Buffer.from([0x81]), 0), null, "incomplete");
});

for (const requestAck of [true, false]) {
  test(`TCPCLv3: contact header exchange and segmented bundles both ways (acks ${requestAck ? "on" : "off"})`, async () => {
    const got = [];
    let srvSide;
    const server = await listen({ port: 0, nodeId: "ipn:10.0", segmentMru: 1000, requestAck }, (s) => { srvSide = s; s.on("bundle", (b) => got.push(b)); });
    const c = await connect({ host: "127.0.0.1", port: server.address().port, nodeId: "ipn:1.0", segmentMru: 1000, requestAck });
    assert.equal(c.peer.nodeId, "ipn:10.0");
    assert.equal(c.peer.acks, requestAck);
    const big = Buffer.alloc(4321, 5);
    await c.send(big);
    await c.send(Buffer.from("second"));
    assert.ok(await until(() => got.length === 2));
    assert.ok(got[0].equals(big));
    assert.equal(got[1].toString(), "second");
    const back = [];
    c.on("bundle", (b) => back.push(b));
    await srvSide.send(Buffer.from("downlink v3"));
    assert.ok(await until(() => back.length === 1));
    await c.close(); server.close();
  });
}

test("gateway pair over TCPCLv3", async () => {
  const sink = dgram.createSocket("udp4");
  const got = [];
  sink.on("message", (m) => got.push(m.toString()));
  await new Promise((r) => sink.bind(0, "127.0.0.1", r));
  const gwB = await new Gateway({ node: 2, spoolDir: mkdtempSync(join(tmpdir(), "gw-")), listenPort: 0, listenCl: "tcpclv3", ipEgress: { 1: { udp: `127.0.0.1:${sink.address().port}` } } }).start();
  const gwA = await new Gateway({ node: 1, spoolDir: mkdtempSync(join(tmpdir(), "gw-")), peer: { host: "127.0.0.1", port: gwB.dtnPort, cl: "tcpclv3" }, ipIngress: { udp: [{ port: 0, dest: "ipn:2.1" }] } }).start();
  const s = dgram.createSocket("udp4");
  for (let i = 0; i < 5; i++) await new Promise((r) => s.send(`v3 frame ${i}`, gwA.udpPorts[0], "127.0.0.1", r));
  s.close();
  assert.ok(await until(() => got.length === 5));
  assert.deepEqual(got, [0, 1, 2, 3, 4].map((i) => `v3 frame ${i}`));
  await gwA.stop(); await gwB.stop(); sink.close();
});

test("a gateway that requires TLS refuses to use TCPCLv3", async () => {
  await assert.rejects(new Gateway({ node: 2, spoolDir: mkdtempSync(join(tmpdir(), "gw-")), listenPort: 0, listenCl: "tcpclv3", tls: { require: true } }).start(), /TCPCLv3 has no TLS/);
});
