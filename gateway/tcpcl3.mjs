// TCP Convergence Layer Protocol version 3 (RFC 7242), the version JPL ION's TCP
// convergence layer speaks. Same interface as tcpcl4.mjs (connect, listen, a Session with
// send(), "bundle" events and close()), so the gateway can use either per peer.
//
// Version 3 differences from version 4: the contact header carries the keepalive interval
// and the node's EID itself (there is no SESS_INIT); lengths are SDNVs; the message type is
// the high nibble of the first byte; segment acknowledgements are used only when both
// sides set the "request acknowledgment" flag; there is no TLS. Without acknowledgements a
// transfer counts as sent once the bytes are handed to the operating system.
import net from "node:net";
import { EventEmitter } from "node:events";

export const MAGIC = Buffer.from("dtn!", "ascii");
export const VERSION = 3;
export const T = { DATA_SEGMENT: 0x1, ACK_SEGMENT: 0x2, REFUSE_BUNDLE: 0x3, KEEPALIVE: 0x4, SHUTDOWN: 0x5, LENGTH: 0x6 };
export const SEG = { END: 0x01, START: 0x02 };
export const FLAG = { REQUEST_ACK: 0x01, REACTIVE_FRAG: 0x02, ALLOW_REFUSAL: 0x04, REQUEST_LENGTH: 0x08 };

// Self-Delimiting Numeric Values (RFC 6256): 7 bits per byte, high bit set on all but the last.
export function sdnv(n) {
  let v = BigInt(n);
  const out = [Number(v & 0x7fn)];
  v >>= 7n;
  while (v > 0n) { out.unshift(Number((v & 0x7fn) | 0x80n)); v >>= 7n; }
  return Buffer.from(out);
}
export function readSdnv(buf, off) {
  let v = 0n;
  for (let i = off; i < buf.length && i < off + 10; i++) {
    v = (v << 7n) | BigInt(buf[i] & 0x7f);
    if (!(buf[i] & 0x80)) return { value: v, end: i + 1 };
  }
  if (buf.length >= off + 10) throw new Error("SDNV longer than 64 bits");
  return null;
}

export function encodeContactHeader({ flags, keepalive, eid }) {
  const id = Buffer.from(eid, "utf8");
  const k = Buffer.alloc(2); k.writeUInt16BE(keepalive);
  return Buffer.concat([MAGIC, Buffer.from([VERSION, flags]), k, sdnv(id.length), id]);
}

export class Parser {
  constructor({ maxSegment }) { this.buf = Buffer.alloc(0); this.headerDone = false; this.maxSegment = maxSegment; }
  push(c) { this.buf = this.buf.length ? Buffer.concat([this.buf, c]) : c; }
  take(n) { const o = this.buf.subarray(0, n); this.buf = this.buf.subarray(n); return o; }
  parse() {
    const b = this.buf;
    if (!this.headerDone) {
      if (b.length < 8) return null;
      if (!b.subarray(0, 4).equals(MAGIC)) { this.headerDone = true; return { kind: "bad_magic" }; }
      const len = readSdnv(b, 8);
      if (!len) return null;
      const n = Number(len.value);
      if (n > 1024) { this.headerDone = true; return { kind: "bad_header" }; }
      if (b.length < len.end + n) return null;
      const h = this.take(len.end + n);
      this.headerDone = true;
      return { kind: "contact", version: h[4], flags: h[5], keepalive: h.readUInt16BE(6), eid: h.subarray(len.end).toString("utf8") };
    }
    if (!b.length) return null;
    const type = b[0] >> 4, flags = b[0] & 0x0f;
    switch (type) {
      case T.DATA_SEGMENT: {
        const len = readSdnv(b, 1);
        if (!len) return null;
        if (len.value > BigInt(this.maxSegment)) return { kind: "too_big", len: len.value };
        const n = Number(len.value);
        if (b.length < len.end + n) return null;
        const m = this.take(len.end + n);
        return { kind: "segment", flags, data: Buffer.from(m.subarray(len.end)) };
      }
      case T.ACK_SEGMENT: case T.LENGTH: {
        const len = readSdnv(b, 1);
        if (!len) return null;
        this.take(len.end);
        return { kind: type === T.ACK_SEGMENT ? "ack" : "length", value: len.value };
      }
      case T.REFUSE_BUNDLE: this.take(1); return { kind: "refuse", reason: flags };
      case T.KEEPALIVE: this.take(1); return { kind: "keepalive" };
      case T.SHUTDOWN: {
        let off = 1;
        if (flags & 0x02) off += 1;
        if (flags & 0x01) { if (b.length < off + 1) return null; const d = readSdnv(b, off); if (!d) return null; off = d.end; }
        if (b.length < off) return null;
        this.take(off);
        return { kind: "shutdown" };
      }
      default: this.take(1); return { kind: "unknown", type };
    }
  }
}

const DEFAULTS = { keepalive: 15, segmentMru: 200000, transferMru: 16 * 1024 * 1024, ackTimeoutMs: 60000, requestAck: true };

export class Session extends EventEmitter {
  constructor(socket, { active, nodeId, allowedPeers, ...opts }) {
    super();
    this.socket = socket;
    this.active = active;
    this.nodeId = nodeId;
    this.allowedPeers = allowedPeers || null;
    this.opts = { ...DEFAULTS, ...opts };
    this.parser = new Parser({ maxSegment: this.opts.transferMru });
    this.state = "contact";
    this.queue = Promise.resolve();
    this.cur = null;            // outbound transfer waiting for acks
    this.rx = null; this.rxBytes = 0;
    this.closed = false;
    this.ready = new Promise((res, rej) => { this._ready = res; this._fail = rej; });
    this.ready.catch(() => {});
    socket.setNoDelay(true);
    socket.on("data", (d) => this._onData(d));
    socket.on("error", (e) => this._teardown(e));
    socket.on("close", () => this._teardown(new Error("connection closed")));
    if (active) this._sendHeader();
  }

  _sendHeader() {
    this._write(encodeContactHeader({ flags: this.opts.requestAck ? FLAG.REQUEST_ACK : 0, keepalive: this.opts.keepalive, eid: this.nodeId }));
  }
  _write(buf, cb) { if (this.closed) return; this.lastTx = Date.now(); this.socket.write(buf, cb); }

  _onData(d) {
    this.lastRx = Date.now();
    this.parser.push(d);
    let m;
    try { while (!this.closed && (m = this.parser.parse())) this._onMessage(m); } catch (e) { this._teardown(e); }
  }

  _onMessage(m) {
    switch (m.kind) {
      case "bad_magic": case "bad_header": return this._teardown(new Error("peer is not speaking TCPCL"));
      case "contact": {
        if (m.version !== VERSION) return this._teardown(new Error(`peer TCPCL version ${m.version}, need 3`));
        if (this.allowedPeers && !this.allowedPeers.includes(m.eid)) return this._teardown(new Error(`peer ${m.eid} is not on the allowed list`));
        if (!this.active) this._sendHeader();
        const keepalive = Math.min(this.opts.keepalive, m.keepalive);
        this.acks = this.opts.requestAck && !!(m.flags & FLAG.REQUEST_ACK);
        this.peerAcks = !!(m.flags & FLAG.REQUEST_ACK);
        this.peer = { nodeId: m.eid, keepalive, acks: this.acks, segmentMru: this.opts.segmentMru, transferMru: this.opts.transferMru, tls: false };
        this.state = "established";
        this._startKeepalive(keepalive);
        this._ready(this);
        this.emit("established", this.peer);
        return;
      }
      case "segment": {
        if (this.state !== "established") return;
        if (m.flags & SEG.START) { this.rx = []; this.rxBytes = 0; }
        if (!this.rx) return;
        this.rx.push(m.data);
        this.rxBytes += m.data.length;
        if (this.rxBytes > this.opts.transferMru) { this._write(Buffer.from([(T.REFUSE_BUNDLE << 4) | 0x2])); this.rx = null; return; }
        if (this.peerAcks) this._write(Buffer.concat([Buffer.from([T.ACK_SEGMENT << 4]), sdnv(this.rxBytes)]));
        if (m.flags & SEG.END) { const b = Buffer.concat(this.rx); this.rx = null; this.emit("bundle", b, this.peer); }
        return;
      }
      case "ack": {
        const c = this.cur;
        if (c && Number(m.value) === c.total) { clearTimeout(c.timer); this.cur = null; c.resolve(); }
        return;
      }
      case "refuse": {
        const c = this.cur;
        if (c) { clearTimeout(c.timer); this.cur = null; c.reject(new Error(`peer refused the bundle (reason ${m.reason})`)); }
        return;
      }
      case "shutdown": this.emit("term"); this.socket.end(); return;
      case "too_big": return this._teardown(new Error(`peer sent a segment of ${m.len} bytes, above our limit`));
      default: return;
    }
  }

  _startKeepalive(seconds) {
    if (!seconds) return;
    this.lastRx = this.lastTx = Date.now();
    this.kaTimer = setInterval(() => {
      const now = Date.now();
      if (now - this.lastRx > 2 * seconds * 1000 + 1000) return this._teardown(new Error("peer silent for twice the keepalive interval"));
      if (now - this.lastTx >= seconds * 1000) this._write(Buffer.from([T.KEEPALIVE << 4]));
    }, Math.max(250, (seconds * 1000) / 4));
    this.kaTimer.unref();
  }

  // Version 3 has no transfer IDs, so transfers go one at a time.
  send(bundle) {
    if (this.state !== "established") return Promise.reject(new Error("session not established"));
    const run = () => new Promise((resolve, reject) => {
      if (this.closed) return reject(new Error("session closed"));
      const seg = Math.max(1, this.opts.segmentMru);
      const total = bundle.length;
      if (this.acks) {
        const timer = setTimeout(() => { this.cur = null; reject(new Error("timed out waiting for the final ACK_SEGMENT")); }, this.opts.ackTimeoutMs);
        timer.unref();
        this.cur = { total, resolve, reject, timer };
      }
      for (let off = 0; off < total; off += seg) {
        const end = Math.min(off + seg, total);
        let flags = 0;
        if (off === 0) flags |= SEG.START;
        if (end === total) flags |= SEG.END;
        const part = bundle.subarray(off, end);
        const last = end === total;
        this._write(Buffer.concat([Buffer.from([(T.DATA_SEGMENT << 4) | flags]), sdnv(part.length), part]), last && !this.acks ? (err) => (err ? reject(err) : resolve()) : undefined);
      }
    });
    const p = this.queue.then(run, run);
    this.queue = p.catch(() => {});
    return p;
  }

  close() {
    if (this.closed) return Promise.resolve();
    this._write(Buffer.from([T.SHUTDOWN << 4]));
    return new Promise((res) => { setTimeout(() => { this._teardown(null); res(); }, 200).unref(); });
  }

  _teardown(err) {
    if (this.closed) return;
    this.closed = true; this.state = "closed";
    clearInterval(this.kaTimer);
    if (this.cur) { clearTimeout(this.cur.timer); this.cur.reject(err || new Error("session closed")); this.cur = null; }
    this._fail(err || new Error("session closed"));
    this.socket.destroy();
    this.emit("close", err);
  }
}

export function connect({ host, port, nodeId, connectTimeoutMs = 10000, ...opts }) {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host, port });
    const t = setTimeout(() => { socket.destroy(); reject(new Error(`no TCPCLv3 session with ${host}:${port} within ${connectTimeoutMs} ms`)); }, connectTimeoutMs);
    socket.once("error", (e) => { clearTimeout(t); reject(e); });
    socket.once("connect", () => {
      const s = new Session(socket, { active: true, nodeId, ...opts });
      s.ready.then((x) => { clearTimeout(t); resolve(x); }, (e) => { clearTimeout(t); reject(e); });
    });
  });
}

export function listen({ port, host = "127.0.0.1", nodeId, allowedIps, ...opts }, onSession) {
  const server = net.createServer((socket) => {
    const ip = String(socket.remoteAddress || "").replace(/^::ffff:/, "");
    if (allowedIps && !allowedIps.includes(ip)) { socket.destroy(); return; }
    const s = new Session(socket, { active: false, nodeId, ...opts });
    s.ready.then(() => onSession(s), () => {});
  });
  return new Promise((resolve, reject) => { server.once("error", reject); server.listen(port, host, () => resolve(server)); });
}
