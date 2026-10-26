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
import { encodeBundle, decodeBundle, payloadOf, BLOCK, BLOCK_FLAG, BUNDLE_FLAG, CRC32C } from "../transport/bpv7/bundle.mjs";
import { encode, decode } from "../transport/bpv7/cbor.mjs";
import { signRecord, verifyRecord } from "../agent/lib/receipt.mjs";
import { canonicalize } from "../agent/lib/canonical.mjs";
import * as tcpcl4 from "./tcpcl4.mjs";
import * as tcpcl3 from "./tcpcl3.mjs";

// Convergence layer per link: "tcpclv4" (RFC 9174, default; HDTN, dtn7, Hardy) or
// "tcpclv3" (RFC 7242; JPL ION's TCP convergence layer). Version 3 has no TLS.
function clFor(name, tlsCfg) {
  const v = name || "tcpclv4";
  if (v === "tcpclv4") return tcpcl4;
  if (v === "tcpclv3") {
    if (tlsCfg && tlsCfg.require) throw new Error("TLS is required but TCPCLv3 has no TLS: use tcpclv4 for this link, or a VPN");
    return tcpcl3;
  }
  throw new Error(`unknown convergence layer ${name}`);
}
import { Spool } from "./spool.mjs";

export const INGRESS_BLOCK_TYPE = 226;
const DTN_EPOCH_MS = Date.UTC(2000, 0, 1);
const sha256 = (b) => createHash("sha256").update(b).digest("hex");

// Endpoint IDs the gateway routes on: ipn:<node>.<service> or dtn://<node>/<demux>.
export function parseEid(eid) {
  let m = /^ipn:(\d+)\.(\d+)$/.exec(eid);
  if (m) return { scheme: "ipn", node: m[1], service: m[2] };
  m = /^dtn:\/\/([^/]+)\/(.*)$/.exec(eid);
  if (m) return { scheme: "dtn", node: m[1], service: m[2] };
  throw new Error(`need an EID like ipn:2.1 or dtn://ground/telemetry, got ${eid}`);
}

export function parseIpn(eid) {
  const e = parseEid(eid);
  if (e.scheme !== "ipn") throw new Error(`need an ipn EID like ipn:2.1, got ${eid}`);
  return { node: Number(e.node), service: Number(e.service) };
}

// Build the BPv7 bundle(s) for one IP payload. Above maxPayload bytes the payload is
// split into fragments (RFC 9171 section 5.8): same source and creation timestamp, each
// with its offset and the total length. The signed ingress receipt covers the whole
// payload and is replicated into every fragment.
export function makeBundles({ payload, source, dest, lifetimeMs, seq, keypair, gateway, from, now = Date.now(), maxPayload = Infinity }) {
  const extra = [];
  if (keypair) {
    const receipt = signRecord(keypair, {
      kind: "gateway-ingress/1", gateway, from, source, dest,
      payloadHash: sha256(payload), payloadBytes: payload.length, receivedAt: new Date(now).toISOString(),
    });
    extra.push({
      type: INGRESS_BLOCK_TYPE, number: 2, flags: BLOCK_FLAG.REPLICATE_IN_FRAGMENTS, crcType: CRC32C,
      data: encode([canonicalize(receipt)]),
    });
  }
  const created = [now - DTN_EPOCH_MS, seq];
  const frag = payload.length > maxPayload;
  const out = [];
  for (let off = 0; off === 0 || off < payload.length; off += maxPayload) {
    const part = frag ? payload.subarray(off, off + maxPayload) : payload;
    const primary = { flags: frag ? BUNDLE_FLAG.IS_FRAGMENT : 0, crcType: CRC32C, dest, source, reportTo: "dtn:none", created, lifetime: lifetimeMs };
    if (frag) { primary.fragmentOffset = off; primary.totalAduLength = payload.length; }
    out.push(encodeBundle({ primary, blocks: [...extra, { type: BLOCK.PAYLOAD, number: 1, flags: 0, crcType: CRC32C, data: part }] }));
    if (!frag) break;
  }
  return out;
}

export const makeBundle = (args) => makeBundles({ ...args, maxPayload: Infinity })[0];

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
    this.cfg = { lifetimeMs: 24 * 3600 * 1000, retryMs: 2000, maxRetryMs: 30000, maxBundlePayload: 1000000, maxReassemblyBytes: 64 * 1024 * 1024, ...cfg };
    // Identity: an ipn node number, or a dtn node name ("dtn://ground-a/").
    if (cfg.nodeId) {
      const e = parseEid(cfg.nodeId);
      this.scheme = e.scheme; this.nodeName = e.node;
      this.nodeId = e.scheme === "ipn" ? `ipn:${e.node}.0` : `dtn://${e.node}/`;
    } else {
      this.scheme = "ipn"; this.nodeName = String(cfg.node); this.nodeId = `ipn:${cfg.node}.0`;
    }
    this.partial = new Map();
    this.partialBytes = 0;
    this.spool = new Spool(cfg.spoolDir);
    this.seq = 0;
    this.session = null;
    this.servers = [];
    this.stats = { fromIp: 0, toDtn: 0, fromDtn: 0, toIp: 0, rejected: 0, fragmentsIn: 0, reassembled: 0 };
    this.log = cfg.log || (() => {});
  }

  async start() {
    const { ipIngress = {}, listenPort } = this.cfg;
    for (const u of ipIngress.udp || []) {
      const sock = dgram.createSocket("udp4");
      sock.on("message", (msg, rinfo) => {
        if (u.allowedSources && !u.allowedSources.includes(rinfo.address)) { this.stats.rejected++; return; }
        this.fromIp(msg, u.dest, `udp:${rinfo.address}:${rinfo.port}`, u.sourceService ?? u.source);
      });
      await new Promise((res) => sock.bind(u.port, u.host || "127.0.0.1", res));
      (this.udpPorts ||= []).push(sock.address().port);
      this.servers.push(sock);
    }
    if (ipIngress.http) await this._startHttp(ipIngress.http);
    if (listenPort != null) {
      const srv = await clFor(this.cfg.listenCl, this.cfg.tls).listen({ port: listenPort, host: this.cfg.listenHost || "127.0.0.1", nodeId: this.nodeId, tls: this.cfg.tls, allowedPeers: this.cfg.allowedPeers, allowedIps: this.cfg.allowedIps }, (s) => {
        this.log(`DTN session in from ${s.peer.nodeId}${s.peer.tls ? " (TLS)" : ""}`);
        this.emit("session-in", s.peer);
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
        try { parseEid(dest); } catch (e) { res.writeHead(400); return res.end(e.message); }
        const max = this.cfg.ipIngress.http.maxBytes || 64 * 1024 * 1024;
        const parts = [];
        let size = 0;
        req.on("data", (c) => {
          size += c.length;
          if (size > max) { res.writeHead(413); res.end(`body over ${max} bytes`); req.destroy(); return; }
          parts.push(c);
        });
        req.on("end", () => {
          if (size > max) return;
          const id = this.fromIp(Buffer.concat(parts), dest, `http:${req.socket.remoteAddress}`, url.searchParams.get("service") ?? undefined);
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
  sourceEid(service) {
    return this.scheme === "ipn" ? `ipn:${this.nodeName}.${service ?? 1}` : `dtn://${this.nodeName}/${service ?? "gateway"}`;
  }

  fromIp(payload, dest, from, sourceService) {
    const all = makeBundles({
      payload, dest, source: this.sourceEid(sourceService), lifetimeMs: this.cfg.lifetimeMs,
      seq: this.seq++, keypair: this.cfg.keypair, gateway: this.nodeId, from, maxPayload: this.cfg.maxBundlePayload,
    });
    const ids = all.map((b) => this.spool.add(b));
    this.stats.fromIp++;
    this.emit("queued", ids[0]);
    this._kick?.();
    return ids.length === 1 ? ids[0] : ids;
  }

  // The local service a bundle is for, or null when it is addressed to another node.
  _localService(dest) {
    let e;
    try { e = parseEid(dest); } catch { return null; }
    return e.scheme === this.scheme && e.node === this.nodeName ? e.service : null;
  }

  // Collect fragments by (source, creation time) until offsets 0..total are all covered,
  // then rebuild one whole bundle from the first fragment's blocks. Returns null while
  // pieces are still missing. Bounded by maxReassemblyBytes; stale sets expire.
  _reassemble(bundle) {
    const p = bundle.primary;
    if (!(p.flags & BUNDLE_FLAG.IS_FRAGMENT)) return bundle;
    const part = payloadOf(bundle);
    if (!(p.totalAduLength > 0) || p.fragmentOffset + part.length > p.totalAduLength) throw new Error("fragment outside its total length");
    const now = Date.now();
    for (const [k, e] of this.partial) if (now - e.at > this.cfg.lifetimeMs) { this.partialBytes -= e.bytes; this.partial.delete(k); }
    const key = `${p.source}|${p.created[0]}|${p.created[1]}`;
    let e = this.partial.get(key);
    if (!e) { e = { total: p.totalAduLength, parts: new Map(), first: null, bytes: 0, at: now }; this.partial.set(key, e); }
    if (e.total !== p.totalAduLength) throw new Error("fragments disagree on the total length");
    if (!e.parts.has(p.fragmentOffset)) {
      if (this.partialBytes + part.length > this.cfg.maxReassemblyBytes) throw new Error("reassembly buffer full");
      e.parts.set(p.fragmentOffset, part); e.bytes += part.length; this.partialBytes += part.length;
    }
    if (p.fragmentOffset === 0) e.first = bundle;
    this.stats.fragmentsIn++;
    const offs = [...e.parts.keys()].sort((a, b) => a - b);
    let end = 0;
    for (const o of offs) { if (o > end) return null; end = Math.max(end, o + e.parts.get(o).length); }
    if (end < e.total || !e.first) return null;
    const whole = Buffer.alloc(e.total);
    for (const o of offs) e.parts.get(o).copy(whole, o);
    this.partial.delete(key); this.partialBytes -= e.bytes;
    this.stats.reassembled++;
    const { fragmentOffset, totalAduLength, ...primary } = e.first.primary;
    return { primary: { ...primary, flags: primary.flags & ~BUNDLE_FLAG.IS_FRAGMENT }, blocks: e.first.blocks.map((b) => (b.type === BLOCK.PAYLOAD ? { ...b, data: whole } : b)) };
  }

  // DTN -> IP: deliver bundles addressed to this node to the configured local endpoint.
  fromDtn(bytes, peer) {
    let bundle;
    try { bundle = decodeBundle(bytes); } catch (e) { this.stats.rejected++; return this.log(`dropped malformed bundle from ${peer}: ${e.message}`); }
    const service = this._localService(bundle.primary.dest);
    if (service === null) { this.stats.rejected++; return this.log(`dropped bundle for ${bundle.primary.dest}: not this node`); }
    try { bundle = this._reassemble(bundle); } catch (e) { this.stats.rejected++; return this.log(`dropped fragment from ${bundle.primary.source}: ${e.message}`); }
    if (!bundle) return;
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
          const { cl, ...peer } = this.cfg.peer;
          this.session = await clFor(cl, this.cfg.tls).connect({ ...peer, nodeId: this.nodeId, tls: this.cfg.tls, allowedPeers: this.cfg.allowedPeers });
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
