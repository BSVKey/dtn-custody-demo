// TCP Convergence Layer Protocol version 4 (RFC 9174), without TLS.
//
// One Session wraps one TCP connection. The active entity (the side that connected) sends
// its contact header first, then its SESS_INIT; the passive entity answers each in turn
// (RFC 9174 sections 4.2 and 4.6). After that either side may send bundles: each bundle is
// one transfer, cut into XFER_SEGMENTs no larger than the peer's Segment MRU and
// acknowledged segment by segment with a cumulative XFER_ACK (section 5.2).
//
//   const s = await connect({ host, port, nodeId: "ipn:1.0" });
//   await s.send(bundleBytes);            // resolves when the peer has acked every byte
//   s.on("bundle", (bytes) => ...);       // a complete transfer from the peer
//   await s.close();                      // SESS_TERM, wait for the reply, then end
//
//   listen({ port, nodeId }, (session) => { session.on("bundle", ...) });
//
// TLS (section 4.4): pass tls: { key, cert, ca, require, verifyNodeId }. Both sides offer
// CAN_TLS in the contact header; when both do, the connection is upgraded to TLS before
// SESS_INIT, so the session parameters and every bundle travel encrypted. With `ca`, each
// side must present a certificate signed by it (mutual TLS). With `verifyNodeId`, the
// peer's certificate must carry its Node ID as a URI subjectAltName (section 4.4.2), so a
// node cannot claim another node's identity. `require` refuses peers that cannot do TLS.
// allowedPeers: [nodeId, ...] refuses any other Node ID at SESS_INIT.
import net from "node:net";
import tls from "node:tls";
import { EventEmitter } from "node:events";

export const MAGIC = Buffer.from("dtn!", "ascii");
export const VERSION = 4;
export const MSG = { XFER_SEGMENT: 1, XFER_ACK: 2, XFER_REFUSE: 3, KEEPALIVE: 4, SESS_TERM: 5, MSG_REJECT: 6, SESS_INIT: 7 };
export const SEG = { END: 0x01, START: 0x02 };
export const CAN_TLS = 0x01;
export const TERM = { UNKNOWN: 0, IDLE_TIMEOUT: 1, VERSION_MISMATCH: 2, BUSY: 3, CONTACT_FAILURE: 4, RESOURCE_EXHAUSTION: 5 };
const REJECT_TYPE_UNKNOWN = 1, REJECT_UNEXPECTED = 3;
const REPLY = 0x01;

const u64 = (n) => { const b = Buffer.alloc(8); b.writeBigUInt64BE(BigInt(n)); return b; };

export function encodeContactHeader(canTls = false) {
  return Buffer.concat([MAGIC, Buffer.from([VERSION, canTls ? 1 : 0])]);
}

export function encodeSessInit({ keepalive, segmentMru, transferMru, nodeId }) {
  const id = Buffer.from(nodeId, "utf8");
  const h = Buffer.alloc(1 + 2);
  h[0] = MSG.SESS_INIT;
  h.writeUInt16BE(keepalive, 1);
  const len = Buffer.alloc(2); len.writeUInt16BE(id.length);
  return Buffer.concat([h, u64(segmentMru), u64(transferMru), len, id, Buffer.alloc(4)]);
}

export function encodeSegment(flags, transferId, data) {
  const head = Buffer.concat([Buffer.from([MSG.XFER_SEGMENT, flags]), u64(transferId)]);
  const ext = flags & SEG.START ? Buffer.alloc(4) : Buffer.alloc(0);
  return Buffer.concat([head, ext, u64(data.length), data]);
}

export function encodeAck(flags, transferId, acked) {
  return Buffer.concat([Buffer.from([MSG.XFER_ACK, flags]), u64(transferId), u64(acked)]);
}

const encodeTerm = (flags, reason) => Buffer.from([MSG.SESS_TERM, flags, reason]);

// Incremental parser over a growing buffer. parse() returns the next complete item or
// null when more bytes are needed. Lengths are checked against our own MRUs before any
// allocation, so a hostile peer cannot make us buffer more than we advertised.
export class Parser {
  constructor({ maxSegment, maxTransfer }) {
    this.buf = Buffer.alloc(0);
    this.headerDone = false;
    this.maxSegment = maxSegment;
    this.maxTransfer = maxTransfer;
  }
  push(chunk) { this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk; }
  take(n) { const out = this.buf.subarray(0, n); this.buf = this.buf.subarray(n); return out; }
  parse() {
    const b = this.buf;
    if (!this.headerDone) {
      if (b.length < 6) return null;
      const h = this.take(6);
      this.headerDone = true;
      if (!h.subarray(0, 4).equals(MAGIC)) return { kind: "bad_magic" };
      return { kind: "contact", version: h[4], flags: h[5] };
    }
    if (b.length < 1) return null;
    const type = b[0];
    switch (type) {
      case MSG.SESS_INIT: {
        if (b.length < 21) return null;
        const idLen = b.readUInt16BE(19);
        if (b.length < 21 + idLen + 4) return null;
        const extLen = b.readUInt32BE(21 + idLen);
        const total = 21 + idLen + 4 + extLen;
        if (b.length < total) return null;
        const m = this.take(total);
        return {
          kind: "sess_init", keepalive: m.readUInt16BE(1),
          segmentMru: m.readBigUInt64BE(3), transferMru: m.readBigUInt64BE(11),
          nodeId: m.subarray(21, 21 + idLen).toString("utf8"),
        };
      }
      case MSG.XFER_SEGMENT: {
        if (b.length < 10) return null;
        const flags = b[1];
        let off = 10;
        if (flags & SEG.START) {
          if (b.length < off + 4) return null;
          off += 4 + b.readUInt32BE(off);
        }
        if (b.length < off + 8) return null;
        const len = b.readBigUInt64BE(off);
        if (len > BigInt(this.maxSegment)) return { kind: "too_big", what: "segment", len };
        off += 8;
        const n = Number(len);
        if (b.length < off + n) return null;
        const m = this.take(off + n);
        return { kind: "segment", flags, transferId: m.readBigUInt64BE(2), data: Buffer.from(m.subarray(off)) };
      }
      case MSG.XFER_ACK: {
        if (b.length < 18) return null;
        const m = this.take(18);
        return { kind: "ack", flags: m[1], transferId: m.readBigUInt64BE(2), acked: m.readBigUInt64BE(10) };
      }
      case MSG.XFER_REFUSE: {
        if (b.length < 10) return null;
        const m = this.take(10);
        return { kind: "refuse", reason: m[1], transferId: m.readBigUInt64BE(2) };
      }
      case MSG.KEEPALIVE: this.take(1); return { kind: "keepalive" };
      case MSG.SESS_TERM: {
        if (b.length < 3) return null;
        const m = this.take(3);
        return { kind: "sess_term", flags: m[1], reason: m[2] };
      }
      case MSG.MSG_REJECT: {
        if (b.length < 3) return null;
        const m = this.take(3);
        return { kind: "reject", reason: m[1], header: m[2] };
      }
      default:
        this.take(1);
        return { kind: "unknown", type };
    }
  }
}

const DEFAULTS = { keepalive: 15, segmentMru: 200000, transferMru: 16 * 1024 * 1024, ackTimeoutMs: 60000 };

export class Session extends EventEmitter {
  constructor(socket, { active, nodeId, tls: tlsOpts, allowedPeers, ...opts }) {
    super();
    this.socket = socket;
    this.tlsOpts = tlsOpts && tlsOpts.key && tlsOpts.cert ? tlsOpts : null;
    this.requireTls = !!(tlsOpts && tlsOpts.require);
    this.allowedPeers = allowedPeers || null;
    this.secure = false;
    this.active = active;
    this.nodeId = nodeId;
    this.opts = { ...DEFAULTS, ...opts };
    this.parser = new Parser({ maxSegment: this.opts.segmentMru, maxTransfer: this.opts.transferMru });
    this.state = "contact";
    this.peer = null;
    this.nextTransferId = 0n;
    this.pending = new Map();   // transferId -> { total, resolve, reject, timer }
    this.rx = new Map();        // transferId -> [Buffer]
    this.rxBytes = new Map();
    this.closed = false;
    this.ready = new Promise((res, rej) => { this._ready = res; this._fail = rej; });
    this.ready.catch(() => {});
    socket.setNoDelay(true);
    this._attach(socket);
    if (active) socket.write(encodeContactHeader(!!this.tlsOpts));
  }

  _attach(sock) {
    sock.on("data", (d) => this._onData(d));
    sock.on("error", (e) => this._teardown(e));
    sock.on("close", () => this._teardown(new Error("connection closed")));
  }

  // Upgrade this connection to TLS in place (RFC 9174 section 4.4). Bytes the peer already
  // sent after its contact header belong to the TLS handshake, so they go back to the socket.
  _startTls() {
    const raw = this.socket;
    raw.removeAllListeners("data");
    raw.pause();
    const left = this.parser.buf;
    this.parser.buf = Buffer.alloc(0);
    if (left.length) raw.unshift(left);
    const o = this.tlsOpts;
    const common = { key: o.key, cert: o.cert, ca: o.ca, minVersion: o.minVersion || "TLSv1.2" };
    const sock = this.active
      ? tls.connect({ socket: raw, ...common, rejectUnauthorized: !!o.ca, checkServerIdentity: () => undefined })
      : new tls.TLSSocket(raw, { isServer: true, ...common, requestCert: !!o.ca, rejectUnauthorized: !!o.ca });
    this.socket = sock;
    this._attach(sock);
    sock.once(this.active ? "secureConnect" : "secure", () => {
      this.secure = true;
      if (this.active) this._sendInit();
    });
    raw.resume();
  }

  _peerCertUris() {
    const c = this.socket.getPeerCertificate ? this.socket.getPeerCertificate() : null;
    const san = (c && c.subjectaltname) || "";
    return san.split(/,\s*/).filter((x) => x.startsWith("URI:")).map((x) => x.slice(4));
  }

  _write(buf) {
    if (this.closed) return;
    this.lastTx = Date.now();
    this.socket.write(buf);
  }

  _sendInit() {
    this._write(encodeSessInit({ keepalive: this.opts.keepalive, segmentMru: this.opts.segmentMru, transferMru: this.opts.transferMru, nodeId: this.nodeId }));
  }

  _onData(d) {
    this.lastRx = Date.now();
    this.parser.push(d);
    let m;
    while (!this.closed && (m = this.parser.parse())) this._onMessage(m);
  }

  _onMessage(m) {
    switch (m.kind) {
      case "bad_magic": return this._teardown(new Error("peer is not speaking TCPCL (bad magic)"));
      case "contact":
        if (m.version !== VERSION) {
          this._write(encodeTerm(0, TERM.VERSION_MISMATCH));
          return this._teardown(new Error(`peer TCPCL version ${m.version}, need 4`));
        }
        {
          const both = !!this.tlsOpts && !!(m.flags & CAN_TLS);
          if (!both && this.requireTls) {
            if (!this.active) this._write(encodeContactHeader(!!this.tlsOpts));
            this._write(encodeTerm(0, TERM.CONTACT_FAILURE));
            return this._teardown(new Error("TLS is required and the peer did not offer it"));
          }
          if (!this.active) this._write(encodeContactHeader(!!this.tlsOpts));
          this.state = "init";
          if (both) return this._startTls();
          if (this.active) this._sendInit();
        }
        return;
      case "sess_init": {
        if (this.state !== "init") return this._reject(MSG.SESS_INIT);
        if (this.tlsOpts && this.tlsOpts.verifyNodeId) {
          if (!this.secure || !this._peerCertUris().includes(m.nodeId)) {
            this._write(encodeTerm(0, TERM.CONTACT_FAILURE));
            return this._teardown(new Error(`peer claims ${m.nodeId} but its certificate does not name it`));
          }
        }
        if (this.allowedPeers && !this.allowedPeers.includes(m.nodeId)) {
          this._write(encodeTerm(0, TERM.CONTACT_FAILURE));
          return this._teardown(new Error(`peer ${m.nodeId} is not on the allowed list`));
        }
        if (!this.active) this._sendInit();
        const keepalive = Math.min(this.opts.keepalive, m.keepalive);
        this.peer = { nodeId: m.nodeId, segmentMru: Number(m.segmentMru), transferMru: Number(m.transferMru), keepalive, tls: this.secure };
        this.state = "established";
        this._startKeepalive(keepalive);
        this._ready(this);
        this.emit("established", this.peer);
        return;
      }
      case "segment": {
        if (this.state !== "established") return this._reject(MSG.XFER_SEGMENT);
        const key = m.transferId;
        if (m.flags & SEG.START) { this.rx.set(key, []); this.rxBytes.set(key, 0); }
        const parts = this.rx.get(key);
        if (!parts) return this._reject(MSG.XFER_SEGMENT);
        parts.push(m.data);
        const got = this.rxBytes.get(key) + m.data.length;
        if (got > this.opts.transferMru) {
          this._write(Buffer.concat([Buffer.from([MSG.XFER_REFUSE, 0x02]), u64(key)]));
          this.rx.delete(key); this.rxBytes.delete(key);
          return;
        }
        this.rxBytes.set(key, got);
        this._write(encodeAck(m.flags, key, got));
        if (m.flags & SEG.END) {
          const bundle = Buffer.concat(parts);
          this.rx.delete(key); this.rxBytes.delete(key);
          this.emit("bundle", bundle, this.peer);
        }
        return;
      }
      case "ack": {
        const p = this.pending.get(m.transferId);
        if (p && (m.flags & SEG.END) && Number(m.acked) === p.total) {
          clearTimeout(p.timer);
          this.pending.delete(m.transferId);
          p.resolve();
        }
        return;
      }
      case "refuse": {
        const p = this.pending.get(m.transferId);
        if (p) { clearTimeout(p.timer); this.pending.delete(m.transferId); p.reject(Object.assign(new Error(`peer refused transfer (reason ${m.reason})`), { refuseReason: m.reason })); }
        return;
      }
      case "keepalive": return;
      case "sess_term":
        if (!(m.flags & REPLY)) this._write(encodeTerm(REPLY, m.reason));
        this.state = "ending";
        this.emit("term", m.reason);
        this.socket.end();
        return;
      case "too_big":
        this._write(encodeTerm(0, TERM.RESOURCE_EXHAUSTION));
        return this._teardown(new Error(`peer sent a ${m.what} of ${m.len} bytes, above our MRU`));
      case "unknown": return this._reject(m.type, REJECT_TYPE_UNKNOWN);
      default: return;
    }
  }

  _reject(type, reason = REJECT_UNEXPECTED) { this._write(Buffer.from([MSG.MSG_REJECT, reason, type])); }

  _startKeepalive(seconds) {
    if (!seconds) return;
    this.lastRx = this.lastTx = Date.now();
    this.kaTimer = setInterval(() => {
      const now = Date.now();
      if (now - this.lastRx > 2 * seconds * 1000 + 1000) {
        this._write(encodeTerm(0, TERM.IDLE_TIMEOUT));
        return this._teardown(new Error("peer silent for twice the keepalive interval"));
      }
      if (now - this.lastTx >= seconds * 1000) this._write(Buffer.from([MSG.KEEPALIVE]));
    }, Math.max(250, (seconds * 1000) / 4));
    this.kaTimer.unref();
  }

  // Send one bundle as one transfer. Resolves once the peer acknowledges every byte.
  send(bundle) {
    if (this.state !== "established") return Promise.reject(new Error("session not established"));
    if (bundle.length > this.peer.transferMru) return Promise.reject(new Error(`bundle of ${bundle.length} bytes exceeds the peer's transfer MRU`));
    const id = this.nextTransferId++;
    const seg = Math.max(1, this.peer.segmentMru);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error("timed out waiting for the final XFER_ACK"));
      }, this.opts.ackTimeoutMs);
      timer.unref();
      this.pending.set(id, { total: bundle.length, resolve, reject, timer });
      for (let off = 0; off < bundle.length || off === 0; off += seg) {
        const end = Math.min(off + seg, bundle.length);
        let flags = 0;
        if (off === 0) flags |= SEG.START;
        if (end === bundle.length) flags |= SEG.END;
        this._write(encodeSegment(flags, id, bundle.subarray(off, end)));
        if (end === bundle.length) break;
      }
    });
  }

  // Orderly end: SESS_TERM, wait briefly for the reply, then close the socket.
  close(reason = TERM.UNKNOWN) {
    if (this.closed) return Promise.resolve();
    this._write(encodeTerm(0, reason));
    return new Promise((res) => {
      const done = () => { this._teardown(null); res(); };
      this.once("term", done);
      setTimeout(done, 2000).unref();
    });
  }

  _teardown(err) {
    if (this.closed) return;
    this.closed = true;
    this.state = "closed";
    clearInterval(this.kaTimer);
    for (const [, p] of this.pending) { clearTimeout(p.timer); p.reject(err || new Error("session closed")); }
    this.pending.clear();
    this._fail(err || new Error("session closed"));
    this.socket.destroy();
    this.emit("close", err);
  }
}

export function connect({ host, port, nodeId, connectTimeoutMs = 10000, ...opts }) {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host, port });
    const t = setTimeout(() => { socket.destroy(); reject(new Error(`no TCPCL session with ${host}:${port} within ${connectTimeoutMs} ms`)); }, connectTimeoutMs);
    socket.once("error", (e) => { clearTimeout(t); reject(e); });
    socket.once("connect", () => {
      const s = new Session(socket, { active: true, nodeId, ...opts });
      s.ready.then((x) => { clearTimeout(t); resolve(x); }, (e) => { clearTimeout(t); reject(e); });
    });
  });
}

// Listen for TCPCLv4 sessions. Binds to 127.0.0.1 unless told otherwise, so nothing is
// reachable from the network by accident. allowedIps drops any other source address
// before a byte is read.
export function listen({ port, host = "127.0.0.1", nodeId, allowedIps, ...opts }, onSession) {
  const server = net.createServer((socket) => {
    const ip = String(socket.remoteAddress || "").replace(/^::ffff:/, "");
    if (allowedIps && !allowedIps.includes(ip)) { socket.destroy(); server.emit("refused", ip); return; }
    const s = new Session(socket, { active: false, nodeId, ...opts });
    s.ready.then(() => onSession(s), () => {});
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => resolve(server));
  });
}
