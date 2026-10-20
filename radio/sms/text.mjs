// Payments and receipts as SMS text. Base64 uses only characters in the GSM-7 basic set, so a
// text never falls back to UCS-2 (which would cut each segment from 160 to 70 characters).
//
//   payment, one text:   BSV1 E <base64 EF>              (B instead of E for BEEF)
//   payment, in parts:   BSV1 E 1/3 <id> <base64 part>   for links with short texts (satellite SMS)
//   receipt reply:       BSV RECEIPT <status> <txid>
//                        R1 <base64 signed receipt>
//
// A 266-byte EF payment is a 364-character text: the phone sends it as 3 joined segments and the
// receiving phone or SMS service puts it back together. <id> is the first 8 bytes of
// sha256(payment) in hex, the same message id the radio frames use.
import { messageId, TYPE } from "../lib/frame.mjs";
import { readReceipt } from "../lib/payment.mjs";

const LETTER = { [TYPE.PAY_EF]: "E", [TYPE.PAY_BEEF]: "B" };
const FROM_LETTER = { E: TYPE.PAY_EF, B: TYPE.PAY_BEEF };
export const SINGLE_MAX = 1530; // 10 joined segments of 153 characters

// maxChars: the longest text the link carries. Above it, the payment goes in parts.
export function paymentTexts(type, msg, { maxChars = SINGLE_MAX } = {}) {
  const b64 = Buffer.from(msg).toString("base64"), L = LETTER[type];
  if (!L) throw new Error(`not a payment type: ${type}`);
  const one = `BSV1 ${L} ${b64}`;
  if (one.length <= maxChars) return [one];
  const id = messageId(Buffer.from(msg)).toString("hex");
  // header "BSV1 E nn/nn <16 hex> " is at most 29 characters
  const room = Math.floor((maxChars - 29) / 4) * 4;
  if (room < 4) throw new Error(`maxChars ${maxChars} is too short`);
  const n = Math.ceil(b64.length / room);
  if (n > 99) throw new Error(`payment needs ${n} texts; the limit is 99`);
  return Array.from({ length: n }, (_, i) => `BSV1 ${L} ${i + 1}/${n} ${id} ${b64.slice(i * room, (i + 1) * room)}`);
}

// One incoming text: { type, msg } for a whole payment, { type, part, of, id, data } for a part,
// or null when it is not ours. Tolerates the spaces and line breaks phones add.
export function parseText(body) {
  const t = String(body ?? "").trim().replace(/\s+/g, " ");
  let m = t.match(/^BSV1 ([EB]) (\d{1,2})\/(\d{1,2}) ([0-9a-f]{16}) ([A-Za-z0-9+/=]+)$/i);
  if (m) {
    const part = +m[2], of = +m[3];
    if (!part || part > of) return null;
    return { type: FROM_LETTER[m[1].toUpperCase()], part, of, id: m[4].toLowerCase(), data: m[5] };
  }
  m = t.match(/^BSV1 ([EB]) ([A-Za-z0-9+/= ]+)$/i);
  if (m) return { type: FROM_LETTER[m[1].toUpperCase()], msg: Buffer.from(m[2].replace(/ /g, ""), "base64") };
  return null;
}

// Collects parts per sender and id; returns { type, msg, id } when a payment is complete and its
// hash matches its id, { corrupt: true } when it does not.
export function textAssembler({ maxAgeMs = 24 * 3600_000 } = {}) {
  const parts = new Map();
  return {
    add(from, p) {
      if (p.msg) return { type: p.type, msg: p.msg, id: messageId(p.msg).toString("hex") };
      const now = Date.now();
      for (const [k, v] of parts) if (now - v.at > maxAgeMs) parts.delete(k);
      const k = `${from} ${p.id}`;
      let e = parts.get(k);
      if (!e) parts.set(k, (e = { of: p.of, type: p.type, got: new Map(), at: now }));
      if (e.of !== p.of || e.type !== p.type) return null;
      e.got.set(p.part, p.data);
      if (e.got.size < e.of) return null;
      parts.delete(k);
      const msg = Buffer.from(Array.from({ length: e.of }, (_, i) => e.got.get(i + 1)).join(""), "base64");
      if (messageId(msg).toString("hex") !== p.id) return { corrupt: true, id: p.id };
      return { type: e.type, msg, id: p.id };
    },
    missing(from, id) {
      const e = parts.get(`${from} ${id}`);
      return e ? Array.from({ length: e.of }, (_, i) => i + 1).filter((i) => !e.got.has(i)) : [];
    },
  };
}

export const receiptText = ({ status, txid, receipt }) => `BSV RECEIPT ${status} ${txid}\nR1 ${Buffer.from(receipt).toString("base64")}`;

// Pull the signed receipt out of a reply text (as pasted, or as received) and verify it.
export function readReceiptText(text, pinnedPub) {
  const m = String(text ?? "").match(/R1\s+([A-Za-z0-9+/=]+)/);
  return m ? readReceipt(Buffer.from(m[1], "base64"), pinnedPub) : null;
}
