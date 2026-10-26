// IP <-> DTN gateway.
//
// A spacecraft or ground system on an always-on IP link (a LEO broadband or optical relay
// network, for example) hands data to the gateway as plain UDP datagrams or HTTP POSTs.
// The gateway wraps each one in a BPv7 bundle (RFC 9171) addressed to a DTN endpoint,
// spools it to disk, and forwards it over TCPCLv4 (RFC 9174) to a DTN node such as NASA
// HDTN or JPL ION. When the IP link or the DTN peer drops, bundles wait on disk and go
// out when the session comes back. In the other direction, the gateway accepts TCPCLv4
// sessions from DTN nodes and delivers each bundle addressed to it to a local UDP or HTTP
// endpoint chosen by the bundle's service number.
//
// Optionally the gateway signs an ingress receipt (block type 226) into every bundle it
// creates: which gateway took which exact bytes from which IP source, and when. The far
// gateway, or any auditor holding the gateway's public key, can check it; DTN nodes that
// do not know block 226 forward it unchanged.
import dgram from "node:dgram";
import http from "node:http";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { encodeBundle, decodeBundle, payloadOf, BLOCK, BLOCK_FLAG, CRC32C } from "../transport/bpv7/bundle.mjs";
import { encode, decode } from "../transport/bpv7/cbor.mjs";
import { signRecord, verifyRecord } from "../agent/lib/receipt.mjs";
import { canonicalize } from "../agent/lib/canonical.mjs";
import { connect, listen } from "./tcpcl4.mjs";
import { Spool } from "./spool.mjs";

export const INGRESS_BLOCK_TYPE = 226;
const DTN_EPOCH_MS = Date.UTC(2000, 0, 1);
const sha256 = (b) => createHash("sha256").update(b).digest("hex");

export function parseIpn(eid) {
  const m = /^ipn:(\d+)\.(\d+)$/.exec(eid);
  if (!m) throw new Error(`need an ipn EID like ipn:2.1, got ${eid}`);
  return { node: Number(m[1]), service: Number(m[2]) };
}

// Build one BPv7 bundle around an IP payload, with an optional signed ingress receipt.
export function makeBundle({ payload, source, dest, lifetimeMs, seq, keypair, gateway, from, now = Date.now() }) {
  const blocks = [];
  if (keypair) {
    const receipt = signRecord(keypair, {
      kind: "gateway-ingress/1", gateway, from, source, dest,
      payloadHash: sha256(payload), payloadBytes: payload.length, receivedAt: new Date(now).toISOString(),
    });
    blocks.push({
      type: INGRESS_BLOCK_TYPE, number: 2, flags: BLOCK_FLAG.REPLICATE_IN_FRAGMENTS, crcType: CRC32C,
      data: encode([canonicalize(receipt)]),
    });
  }
  blocks.push({ type: BLOCK.PAYLOAD, number: 1, flags: 0, crcType: CRC32C, data: payload });
  return encodeBundle({
    primary: { flags: 0, crcType: CRC32C, dest, source, reportTo: "dtn:none", created: [now - DTN_EPOCH_MS, seq], lifetime: lifetimeMs },
    blocks,
  });
}

// Check a bundle's ingress receipt: present, signed by a pinned gateway key, and bound to
// this exact payload. Returns { ok, reason?, receipt? }.
export function verifyIngress(bundle, pinnedKeys) {
  const blk = bundle.blocks.find((b) => b.type === INGRESS_BLOCK_TYPE);
  if (!blk) return { ok: false, reason: "no_ingress_receipt" };
  let receipt;
  try { receipt = JSON.parse(decode(blk.data)[0]); } catch { return { ok: false, reason: "ingress_block_malformed" }; }
  const v = verifyRecord(receipt);
  if (!v.ok) return { ok: false, reason: v.reason };
  if (pinnedKeys && pinnedKeys[receipt.gateway] !== v.signer) return { ok: false, reason: "gateway_key_not_pinned", receipt };
  if (receipt.payloadHash !== sha256(payloadOf(bundle))) return { ok: false, reason: "payload_changed", receipt };
  return { ok: true, receipt };
}

export class Gateway extends EventEmitter {
  constructor(cfg) {
    super();
    this.cfg = { lifetimeMs: 24 * 3600 * 1000, retryMs: 2000, maxRetryMs: 30000, ...cfg };
    this.nodeId = `ipn:${cfg.node}.0`;
    this.spool = new Spool(cfg.spoolDir);
    this.seq = 0;
    this.session = null;
    this.servers = [];
    this.stats = { fromIp: 0, toDtn: 0, fromDtn: 0, toIp: 0, rejected: 0 };
    this.log = cfg.log || (() => {});
  }

  async start() {
    const { ipIngress = {}, listenPort } = this.cfg;
    for (const u of ipIngress.udp || []) {
      const sock = dgram.createSocket("udp4");
      sock.on("message", (msg, rinfo) => {
        if (u.allowedSources && !u.allowedSources.includes(rinfo.address)) { this.stats.rejected++; return; }
        this.fromIp(msg, u.dest, `udp:${rinfo.address}:${rinfo.port}`, u.sourceService);
      });
      await new Promise((res) => sock.bind(u.port, u.host || "127.0.0.1", res));
      (this.udpPorts ||= []).push(sock.address().port);
      this.servers.push(sock);
    }
    if (ipIngress.http) await this._startHttp(ipIngress.http);
    if (listenPort != null) {
      const srv = await listen({ port: listenPort, host: this.cfg.listenHost || "127.0.0.1", nodeId: this.nodeId, tls: this.cfg.tls, allowedPeers: this.cfg.allowedPeers, allowedIps: this.cfg.allowedIps }, (s) => {
        this.log(`DTN session in from ${s.peer.nodeId}`);
        s.on("bundle", (b) => this.fromDtn(b, s.peer.nodeId));
      });
      this.dtnPort = srv.address().port;
      this.servers.push(srv);
    }
    this._egress = dgram.createSocket("udp4");
    if (this.cfg.peer) this._pump();
    return this;
  }

  _startHttp({ port, host = "127.0.0.1", token }) {
    const srv = http.createServer((req, res) => {
      const url = new URL(req.url, "http://x");
      if (token && req.headers.authorization !== `Bearer ${token}`) { res.writeHead(401); return res.end("bearer token required"); }
      if (req.method === "GET" && url.pathname === "/status") {
        res.writeHead(200, { "content-type": "application/json" });
        return res.end(JSON.stringify({ node: this.nodeId, connected: !!this.session, waiting: this.spool.size, stats: this.stats }));
      }
      if (req.method === "POST" && url.pathname === "/bundles") {
        const dest = url.searchParams.get("dest");
        try { parseIpn(dest); } catch (e) { res.writeHead(400); return res.end(e.message); }
        const parts = [];
        req.on("data", (c) => parts.push(c));
        req.on("end", () => {
          const id = this.fromIp(Buffer.concat(parts), dest, `http:${req.socket.remoteAddress}`, Number(url.searchParams.get("service") || 1));
          res.writeHead(202, { "content-type": "application/json" });
          res.end(JSON.stringify({ queued: id, dest }));
        });
        return;
      }
      res.writeHead(404); res.end();
    });
    this.servers.push(srv);
    return new Promise((r) => srv.listen(port, host, () => { this.httpPort = srv.address().port; r(); }));
  }

  // IP -> DTN: wrap, sign (optional), spool, and wake the sender.
  fromIp(payload, dest, from, sourceService = 1) {
    const bytes = makeBundle({
      payload, dest, source: `ipn:${this.cfg.node}.${sourceService}`, lifetimeMs: this.cfg.lifetimeMs,
      seq: this.seq++, keypair: this.cfg.keypair, gateway: this.nodeId, from,
    });
    const id = this.spool.add(bytes);
    this.stats.fromIp++;
    this.emit("queued", id);
    this._kick?.();
    return id;
  }

  // DTN -> IP: deliver bundles addressed to this node to the configured local endpoint.
  fromDtn(bytes, peer) {
    let bundle;
    try { bundle = decodeBundle(bytes); } catch (e) { this.stats.rejected++; return this.log(`dropped malformed bundle from ${peer}: ${e.message}`); }
    const { node, service } = parseIpn(bundle.primary.dest);
    if (node !== this.cfg.node) { this.stats.rejected++; return this.log(`dropped bundle for ${bundle.primary.dest}: not this node`); }
    this.stats.fromDtn++;
    const ingress = bundle.blocks.some((b) => b.type === INGRESS_BLOCK_TYPE) ? verifyIngress(bundle, this.cfg.pinnedGateways) : null;
    if (this.cfg.requireIngressReceipt && !(ingress && ingress.ok)) {
      this.stats.rejected++;
      return this.log(`dropped bundle from ${bundle.primary.source}: ingress receipt ${ingress ? ingress.reason : "missing"}`);
    }
    const payload = payloadOf(bundle);
    const out = (this.cfg.ipEgress || {})[String(service)];
    this.emit("delivered", { source: bundle.primary.source, dest: bundle.primary.dest, payload, ingress });
    if (out && out.udp) {
      const [h, p] = out.udp.split(":");
      this._egress.send(payload, Number(p), h);
      this.stats.toIp++;
    }
  }

  // Keep one TCPCLv4 session to the peer and drain the spool through it, oldest first.
  async _pump() {
    let backoff = this.cfg.retryMs;
    while (!this.stopped) {
      try {
        if (!this.session) {
          this.session = await connect({ ...this.cfg.peer, nodeId: this.nodeId, tls: this.cfg.tls, allowedPeers: this.cfg.allowedPeers });
          this.log(`DTN session up with ${this.session.peer.nodeId}`);
          this.emit("connected", this.session.peer);
          this.session.on("bundle", (b) => this.fromDtn(b, this.session?.peer?.nodeId));
          this.session.on("close", () => { this.session = null; this.emit("disconnected"); this._kick?.(); });
          backoff = this.cfg.retryMs;
        }
        const name = this.spool.list()[0];
        if (!name) { await new Promise((r) => { this._kick = r; }); this._kick = null; continue; }
        await this.session.send(this.spool.read(name));
        this.spool.done(name);
        this.stats.toDtn++;
        this.emit("sent", name);
      } catch (e) {
        if (this.stopped) break;
        this.log(`DTN link: ${e.message}; retry in ${backoff} ms`);
        try { this.session?._teardown(e); } catch {}
        this.session = null;
        await new Promise((r) => setTimeout(r, backoff));
        backoff = Math.min(backoff * 2, this.cfg.maxRetryMs);
      }
    }
  }

  async stop() {
    this.stopped = true;
    this._kick?.();
    if (this.session) await this.session.close();
    for (const s of this.servers) s.close();
    this._egress?.close();
  }
}
