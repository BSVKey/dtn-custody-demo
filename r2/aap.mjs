// Minimal µD3TN Application Agent Protocol (AAP v1) client in Node, so our tested JS
// agent can send/receive bundles over REAL BPv7 without re-porting the crypto. Wire
// format (doc/ud3tn_aap.md): header byte 0x10|type; EID msgs carry !H length + ascii
// EID; bundle msgs add !Q length + payload; SENDCONFIRM/CANCEL carry a !Q bundle id.
import net from "node:net";
import { EventEmitter } from "node:events";

const T = { ACK: 0, NACK: 1, REGISTER: 2, SENDBUNDLE: 3, RECVBUNDLE: 4, SENDCONFIRM: 5, CANCELBUNDLE: 6, WELCOME: 7, PING: 8 };
const NEED_EID = new Set([T.REGISTER, T.SENDBUNDLE, T.RECVBUNDLE, T.WELCOME]);
const NEED_PL = new Set([T.SENDBUNDLE, T.RECVBUNDLE]);
const NEED_BID = new Set([T.SENDCONFIRM, T.CANCELBUNDLE]);

function serialize(type, eid, payload) {
  const parts = [Buffer.from([0x10 | (type & 0xf)])];
  if (eid != null) { const e = Buffer.from(eid, "ascii"); const l = Buffer.alloc(2); l.writeUInt16BE(e.length); parts.push(l, e); }
  if (payload != null) { const l = Buffer.alloc(8); l.writeBigUInt64BE(BigInt(payload.length)); parts.push(l, payload); }
  return Buffer.concat(parts);
}

export class AAP extends EventEmitter {
  constructor() { super(); this.buf = Buffer.alloc(0); }

  connect(host, port, tries = 50) {
    return new Promise((resolve, reject) => {
      const attempt = (n) => {
        const s = net.connect(port, host);
        s.once("error", () => { if (n <= 0) reject(new Error("aap connect failed")); else setTimeout(() => attempt(n - 1), 200); });
        s.once("connect", () => {
          this.sock = s; s.on("error", () => {});
          s.on("data", (d) => { this.buf = Buffer.concat([this.buf, d]); this._parse(); });
          this.once("welcome", () => resolve(this));
        });
      };
      attempt(tries);
    });
  }

  _parse() {
    for (;;) {
      if (this.buf.length < 1) return;
      const type = this.buf[0] & 0xf;
      let off = 1, eid = null, payload = null, bundleId = null;
      if (NEED_EID.has(type)) { if (this.buf.length < off + 2) return; const el = this.buf.readUInt16BE(off); off += 2; if (this.buf.length < off + el) return; eid = this.buf.slice(off, off + el).toString("ascii"); off += el; }
      if (NEED_PL.has(type)) { if (this.buf.length < off + 8) return; const pl = Number(this.buf.readBigUInt64BE(off)); off += 8; if (this.buf.length < off + pl) return; payload = this.buf.slice(off, off + pl); off += pl; }
      if (NEED_BID.has(type)) { if (this.buf.length < off + 8) return; bundleId = this.buf.readBigUInt64BE(off); off += 8; }
      this.buf = this.buf.slice(off);
      this._dispatch(type, eid, payload, bundleId);
    }
  }

  _dispatch(type, eid, payload, bundleId) {
    if (type === T.WELCOME) { this.nodeEid = eid; this.emit("welcome", eid); }
    else if (type === T.ACK) this.emit("ack");
    else if (type === T.NACK) this.emit("nack");
    else if (type === T.SENDCONFIRM) this.emit("sendconfirm", bundleId);
    else if (type === T.RECVBUNDLE) { this.sock.write(Buffer.from([0x10 | T.ACK])); this.emit("bundle", eid, payload); }
    else if (type === T.PING) this.sock.write(Buffer.from([0x10 | T.ACK]));
  }

  register(agentId) {
    return new Promise((res) => { this.once("ack", res); this.sock.write(serialize(T.REGISTER, agentId)); });
  }
  send(destEid, payloadBuf) {
    return new Promise((res) => { this.once("sendconfirm", res); this.sock.write(serialize(T.SENDBUNDLE, destEid, payloadBuf)); });
  }
}
