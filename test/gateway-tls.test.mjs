import test from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { connect, listen } from "../gateway/tcpcl4.mjs";
import { Gateway } from "../gateway/gateway.mjs";
import { makeCerts } from "../gateway/certs.mjs";

let haveOpenssl = true;
try { execFileSync("openssl", ["version"], { stdio: "pipe" }); } catch { haveOpenssl = false; }
const opt = { skip: haveOpenssl ? false : "openssl not installed" };

const certs = haveOpenssl ? makeCerts(mkdtempSync(join(tmpdir(), "pki-")), ["ipn:1.0", "ipn:2.0", "ipn:3.0"]) : null;
const other = haveOpenssl ? makeCerts(mkdtempSync(join(tmpdir(), "pki2-")), ["ipn:1.0"]) : null;
const tlsFor = (id, extra = {}) => ({ key: certs[id].key, cert: certs[id].cert, ca: certs.ca, require: true, verifyNodeId: true, ...extra });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 5000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await fn()) return true; await wait(20); } return false; };

// A TCP relay that records every byte crossing it, to see what an eavesdropper sees.
async function tap(targetPort) {
  const seen = [];
  const srv = net.createServer((c) => {
    const up = net.connect(targetPort, "127.0.0.1");
    c.on("data", (d) => { seen.push(d); up.write(d); });
    up.on("data", (d) => { seen.push(d); c.write(d); });
    c.on("close", () => up.destroy()); up.on("close", () => c.destroy());
    c.on("error", () => {}); up.on("error", () => {});
  });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  return { port: srv.address().port, seen: () => Buffer.concat(seen), close: () => srv.close() };
}

test("certificates name the Node ID the RFC 9174 way (otherName id-on-bundleEID) and the parser reads it", opt, async () => {
  const { X509Certificate } = await import("node:crypto");
  const { bundleEidsFromCert } = await import("../gateway/tcpcl4.mjs");
  for (const id of ["ipn:1.0", "ipn:2.0"]) assert.deepEqual(bundleEidsFromCert(new X509Certificate(certs[id].cert).raw), [id]);
  assert.deepEqual(bundleEidsFromCert(new X509Certificate(certs.ca).raw), [], "the CA names no node");
});

test("TLS: mutual certificates, Node ID checked against the certificate, bundles both ways", opt, async () => {
  const got = [];
  let srvSide;
  const server = await listen({ port: 0, nodeId: "ipn:2.0", tls: tlsFor("ipn:2.0") }, (s) => { srvSide = s; s.on("bundle", (b) => got.push(b)); });
  const c = await connect({ host: "127.0.0.1", port: server.address().port, nodeId: "ipn:1.0", tls: tlsFor("ipn:1.0") });
  assert.equal(c.peer.tls, true);
  assert.equal(c.peer.nodeId, "ipn:2.0");
  const big = Buffer.alloc(450000, 3);
  await c.send(big);
  assert.ok(await until(() => got.length === 1));
  assert.ok(got[0].equals(big));
  const back = [];
  c.on("bundle", (b) => back.push(b));
  await srvSide.send(Buffer.from("over tls"));
  assert.ok(await until(() => back.length === 1));
  await c.close(); server.close();
});

test("TLS: an eavesdropper sees the payload without TLS and not with it", opt, async () => {
  const marker = Buffer.from("SECRET-TELEMETRY-MARKER-7f3a");
  for (const useTls of [false, true]) {
    const got = [];
    const server = await listen({ port: 0, nodeId: "ipn:2.0", ...(useTls ? { tls: tlsFor("ipn:2.0") } : {}) }, (s) => s.on("bundle", (b) => got.push(b)));
    const t = await tap(server.address().port);
    const c = await connect({ host: "127.0.0.1", port: t.port, nodeId: "ipn:1.0", ...(useTls ? { tls: tlsFor("ipn:1.0") } : {}) });
    await c.send(Buffer.concat([marker, Buffer.alloc(100)]));
    assert.ok(await until(() => got.length === 1));
    assert.equal(t.seen().includes(marker), !useTls, useTls ? "encrypted on the wire" : "plain on the wire");
    await c.close(); server.close(); t.close();
  }
});

test("TLS: a node presenting another node's certificate is refused", opt, async () => {
  const server = await listen({ port: 0, nodeId: "ipn:2.0", tls: tlsFor("ipn:2.0") }, () => assert.fail("must not establish"));
  // Holds a valid certificate for ipn:3.0 but claims to be ipn:1.0.
  await assert.rejects(connect({ host: "127.0.0.1", port: server.address().port, nodeId: "ipn:1.0", tls: tlsFor("ipn:3.0") }));
  server.close();
});

test("TLS: a certificate from a different CA is refused", opt, async () => {
  const server = await listen({ port: 0, nodeId: "ipn:2.0", tls: tlsFor("ipn:2.0") }, () => assert.fail("must not establish"));
  await assert.rejects(connect({ host: "127.0.0.1", port: server.address().port, nodeId: "ipn:1.0", tls: { key: other["ipn:1.0"].key, cert: other["ipn:1.0"].cert, ca: other.ca, require: true } }));
  server.close();
});

test("TLS required: a peer that does not offer TLS is refused", opt, async () => {
  const server = await listen({ port: 0, nodeId: "ipn:2.0", tls: tlsFor("ipn:2.0") }, () => assert.fail("must not establish"));
  await assert.rejects(connect({ host: "127.0.0.1", port: server.address().port, nodeId: "ipn:1.0" }));
  server.close();
});

test("allowed peers: an unlisted Node ID is refused", async () => {
  const server = await listen({ port: 0, nodeId: "ipn:2.0", allowedPeers: ["ipn:1.0"] }, () => {});
  const port = server.address().port;
  const ok = await connect({ host: "127.0.0.1", port, nodeId: "ipn:1.0" });
  await ok.close();
  await assert.rejects(connect({ host: "127.0.0.1", port, nodeId: "ipn:9.0" }));
  server.close();
});

test("allowed IPs: other addresses are dropped before any byte is read", async () => {
  const server = await listen({ port: 0, nodeId: "ipn:2.0", allowedIps: ["10.9.9.9"] }, () => assert.fail("must not establish"));
  await assert.rejects(connect({ host: "127.0.0.1", port: server.address().port, nodeId: "ipn:1.0", connectTimeoutMs: 2000 }));
  server.close();
});

test("gateway: binds DTN and HTTP to localhost by default and enforces the HTTP token", async () => {
  const gw = await new Gateway({ node: 2, spoolDir: mkdtempSync(join(tmpdir(), "gw-")), listenPort: 0, ipIngress: { http: { port: 0, token: "t0k3n" } } }).start();
  const dtnAddr = gw.servers.find((s) => s.address && s.address().port === gw.dtnPort).address();
  assert.equal(dtnAddr.address, "127.0.0.1");
  assert.equal((await fetch(`http://127.0.0.1:${gw.httpPort}/status`)).status, 401);
  assert.equal((await fetch(`http://127.0.0.1:${gw.httpPort}/status`, { headers: { authorization: "Bearer t0k3n" } })).status, 200);
  await gw.stop();
});

test("gateway pair over mutual TLS end to end", opt, async () => {
  const dgram = await import("node:dgram");
  const got = [];
  const sink = dgram.createSocket("udp4");
  sink.on("message", (m) => got.push(m.toString()));
  await new Promise((r) => sink.bind(0, "127.0.0.1", r));
  const gwB = await new Gateway({ node: 2, spoolDir: mkdtempSync(join(tmpdir(), "gw-")), listenPort: 0, tls: tlsFor("ipn:2.0"), allowedPeers: ["ipn:1.0"], ipEgress: { 1: { udp: `127.0.0.1:${sink.address().port}` } } }).start();
  const gwA = await new Gateway({ node: 1, spoolDir: mkdtempSync(join(tmpdir(), "gw-")), tls: tlsFor("ipn:1.0"), peer: { host: "127.0.0.1", port: gwB.dtnPort }, ipIngress: { udp: [{ port: 0, dest: "ipn:2.1" }] } }).start();
  const s = dgram.createSocket("udp4");
  for (let i = 0; i < 5; i++) await new Promise((r) => s.send(`tls frame ${i}`, gwA.udpPorts[0], "127.0.0.1", r));
  s.close();
  assert.ok(await until(() => got.length === 5));
  assert.deepEqual(got, [0, 1, 2, 3, 4].map((i) => `tls frame ${i}`));
  await gwA.stop(); await gwB.stop(); sink.close();
});
