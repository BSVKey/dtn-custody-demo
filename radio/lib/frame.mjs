// Radio frames: split one message (a signed payment, a NACK, a receipt) into packets small
// enough for a LoRa radio, and put them back together on the far side.
//
//   0      'R' (0x52)
//   1      version (1)
//   2      type: 1 PAY_EF, 2 PAY_BEEF, 3 NACK, 4 RECEIPT
//   3..10  message id: the first 8 bytes of sha256(message)
//   11     frame index
//   12     frame count
//   13..   data
//
// The default MTU of 200 bytes stays under Meshtastic's 233-byte data payload. The message id
// is a hash of the whole message, so a reassembled message that does not hash to its id is
// dropped rather than handed on.
import { createHash } from "node:crypto";

export const MAGIC = 0x52, VERSION = 1, HEADER = 13, DEFAULT_MTU = 200;
export const TYPE = { PAY_EF: 1, PAY_BEEF: 2, NACK: 3, RECEIPT: 4 };

export const messageId = (msg) => createHash("sha256").update(msg).digest().subarray(0, 8);

export function split(type, msg, { mtu = DEFAULT_MTU, id = messageId(msg) } = {}) {
  const room = mtu - HEADER;
  if (room < 1) throw new Error(`mtu ${mtu} leaves no room for data`);
  const total = Math.max(1, Math.ceil(msg.length / room));
  if (total > 255) throw new Error(`message of ${msg.length} bytes needs ${total} frames; the limit is 255`);
  const frames = [];
  for (let i = 0; i < total; i++) {
    const data = msg.subarray(i * room, (i + 1) * room);
    const f = Buffer.alloc(HEADER + data.length);
    f[0] = MAGIC; f[1] = VERSION; f[2] = type; id.copy(f, 3); f[11] = i; f[12] = total;
    data.copy(f, HEADER);
    frames.push(f);
  }
  return frames;
}

// Returns null for anything that is not one of our frames (other traffic on a shared channel).
export function parse(frame) {
  const f = Buffer.from(frame);
  if (f.length < HEADER || f[0] !== MAGIC || f[1] !== VERSION) return null;
  const total = f[12], index = f[11];
  if (!total || index >= total || !Object.values(TYPE).includes(f[2])) return null;
  return { type: f[2], id: f.subarray(3, 11).toString("hex"), index, total, data: f.subarray(HEADER) };
}

// Collects frames per message id. add() returns the whole message once every frame is in and it
// hashes to its id; missing() lists what a NACK should ask for.
export function reassembler({ verifyHash = true } = {}) {
  const parts = new Map();
  return {
    add(p) {
      let m = parts.get(p.id);
      if (!m) parts.set(p.id, (m = { type: p.type, total: p.total, got: new Map(), last: Date.now() }));
      if (m.total !== p.total || m.type !== p.type) return null;
      m.got.set(p.index, p.data); m.last = Date.now();
      if (m.got.size < m.total) return null;
      const msg = Buffer.concat([...Array(m.total).keys()].map((i) => m.got.get(i)));
      parts.delete(p.id);
      if (verifyHash && messageId(msg).toString("hex") !== p.id) return { type: m.type, id: p.id, corrupt: true };
      return { type: m.type, id: p.id, msg };
    },
    missing(id) {
      const m = parts.get(id);
      return m ? [...Array(m.total).keys()].filter((i) => !m.got.has(i)) : [];
    },
    pending() { return [...parts.entries()].map(([id, m]) => ({ id, type: m.type, total: m.total, have: m.got.size, last: m.last })); },
    drop(id) { parts.delete(id); },
  };
}

// LoRa time on air for one packet (Semtech AN1200.13). overhead is what the radio firmware adds
// around our bytes; about 22 for a Meshtastic packet header plus its Data wrapper (approximate).
export function airtimeMs(payloadBytes, { sf = 11, bwHz = 250_000, cr = 1, preamble = 16, overhead = 22, crc = true, explicitHeader = true } = {}) {
  const tSym = (2 ** sf) / bwHz * 1000;
  const de = tSym > 16 ? 1 : 0;
  const pl = payloadBytes + overhead;
  const n = Math.ceil((8 * pl - 4 * sf + 28 + 16 * (crc ? 1 : 0) - 20 * (explicitHeader ? 0 : 1)) / (4 * (sf - 2 * de)));
  return (preamble + 4.25) * tSym + (8 + Math.max(n * (cr + 4), 0)) * tSym;
}

// Meshtastic modem presets (firmware defaults; LongFast is the factory setting).
export const PRESETS = {
  ShortFast: { sf: 7, bwHz: 250_000, cr: 1 },
  MediumFast: { sf: 9, bwHz: 250_000, cr: 1 },
  LongFast: { sf: 11, bwHz: 250_000, cr: 1 },
  LongSlow: { sf: 12, bwHz: 125_000, cr: 4 },
};
