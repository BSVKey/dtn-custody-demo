// Custodian fast path for version 2 receipts: the same bytes on the wire as stampBundleV2
// (draft -01: COSE_Sign1, EdDSA, SHA-256, block 224), with the work moved off the
// forwarding path.
//
// stampBundleV2 starts when the whole bundle has arrived: it decodes every block (checking
// every CRC, including CRC-32C over the payload), hashes the payload, signs, and re-encodes
// every block (computing every CRC again). Here:
//
//   1. BundleReceiver is fed the bytes as the convergence layer delivers them. It checks
//      the payload CRC and computes the payload SHA-256 incrementally, so both are ready
//      when the last byte lands. It never parses the payload.
//   2. stampReceived builds the receipt payload from cached CBOR pieces, signs it, and
//      splices a new block 224 in before the payload. Every other block is forwarded as the
//      exact bytes received: nothing else is re-encoded and no other CRC is recomputed.
//   3. stampReceivedParts returns the bundle as a list of buffers for a gathering write
//      (writev), so the payload is never copied.
//
// For bundles whose blocks are canonical CBOR (everything this repository emits) the output
// is byte-identical to stampBundleV2 (test/bpv7-fast-stamp.test.mjs). For a bundle with a
// non-canonical block from another implementation, stampBundleV2 would normalise that block;
// this path forwards it unchanged, which is what RFC 9171 expects of a forwarder anyway.
import { createHash } from "node:crypto";
import { encode, decode, decodeAt, bstr } from "./cbor.mjs";
import { sealBlock, decodeEid, crc16x25Update, crc32cUpdate, BLOCK, BLOCK_FLAG, BUNDLE_FLAG, CRC_NONE, CRC16, CRC32C } from "./bundle.mjs";
import { CUSTODY_BLOCK_TYPE } from "./custody-block.mjs";
import { sign1Encoded } from "./cose.mjs";

const MAX_RECEIPTS = 64; // as receipt-v2.mjs
const crcLen = (t) => (t === CRC16 ? 2 : t === CRC32C ? 4 : 0);
const truncated = (e) => e instanceof Error && e.message === "CBOR truncated";

// Read a CBOR head (major type and argument) at p. Throws "CBOR truncated" if incomplete.
function readHead(buf, p) {
  if (p >= buf.length) throw new Error("CBOR truncated");
  const ib = buf[p], major = ib >> 5, ai = ib & 31;
  const n = ai < 24 ? 0 : ai === 24 ? 1 : ai === 25 ? 2 : ai === 26 ? 4 : ai === 27 ? 8 : -1;
  if (n < 0) throw new Error(`unsupported CBOR head ${ib}`);
  if (p + 1 + n > buf.length) throw new Error("CBOR truncated");
  const arg = n === 0 ? ai : n === 1 ? buf[p + 1] : n === 2 ? buf.readUInt16BE(p + 1) : n === 4 ? buf.readUInt32BE(p + 1) : Number(buf.readBigUInt64BE(p + 1));
  return { major, arg, next: p + 1 + n };
}

function checkCrc(raw, type, value) {
  if (type === CRC_NONE) return true;
  const n = crcLen(type);
  if (!Buffer.isBuffer(value) || value.length !== n) return false;
  const zeroed = Buffer.from(raw);
  zeroed.fill(0, raw.length - n);
  if (type === CRC16) { const c = (crc16x25Update(0xffff, zeroed) ^ 0xffff) & 0xffff; return value.readUInt16BE(0) === c; }
  return value.readUInt32BE(0) === ((crc32cUpdate(0xffffffff, zeroed) ^ 0xffffffff) >>> 0);
}

// Incremental receiver for one bundle. push(chunk) as bytes arrive; finish() when the
// convergence layer says the bundle is complete.
export class BundleReceiver {
  constructor() {
    this.head = Buffer.alloc(0); // bytes before the payload data starts
    this.off = 1;                // next top-level item in `head`
    this.raws = [];              // [{ start, end }] primary and extension blocks
    this.buf = null;             // whole bundle, allocated once the payload length is known
    this.w = 0;
    this.sha = createHash("sha256");
  }

  push(chunk) {
    if (this.buf) return this.#body(chunk, 0);
    this.head = this.head.length ? Buffer.concat([this.head, chunk]) : Buffer.from(chunk);
    if (this.head[0] !== 0x9f) throw new Error("a bundle is an indefinite-length CBOR array");
    this.#scan();
  }

  #scan() {
    const h = this.head;
    while (!this.buf) {
      const off = this.off;
      if (off >= h.length) return;
      if (h[off] === 0xff) throw new Error("bundle ends before a payload block");
      try {
        if (this.raws.length) {
          const a = readHead(h, off);
          if (a.major !== 4 || (a.arg !== 5 && a.arg !== 6)) throw new Error(`block ${this.raws.length} malformed`);
          const type = decodeAt(h, a.next);
          if (type.value === BLOCK.PAYLOAD) {
            const number = decodeAt(h, type.end), flags = decodeAt(h, number.end), crc = decodeAt(h, flags.end);
            const d = readHead(h, crc.end);
            if (d.major !== 2) throw new Error("payload block data is not a byte string");
            if ((crc.value ? 6 : 5) !== a.arg) throw new Error("payload block CRC field does not match its CRC type");
            const n = crcLen(crc.value), dataStart = d.next, dataEnd = d.next + d.arg;
            const blockEnd = dataEnd + (n ? 1 + n : 0);
            this.p = { start: off, dataStart, dataEnd, blockEnd, crcType: crc.value, number: number.value, flags: flags.value };
            this.crc = crc.value === CRC16 ? 0xffff : 0xffffffff;
            this.buf = Buffer.allocUnsafe(blockEnd + 1);
            this.#body(h, 0);
            return;
          }
        }
        const r = decodeAt(h, off);
        this.raws.push({ start: off, end: r.end, value: r.value });
        this.off = r.end;
      } catch (e) {
        if (truncated(e)) return; // wait for more bytes
        throw e;
      }
    }
  }

  // Copy bytes into place; hash payload data and run the payload block CRC over what arrived.
  #body(chunk, from) {
    const len = chunk.length - from, at = this.w;
    if (at + len > this.buf.length) throw new Error("trailing bytes after bundle");
    chunk.copy(this.buf, at, from);
    this.w += len;
    const { start, dataStart, dataEnd, blockEnd, crcType } = this.p;
    const ds = Math.max(at, dataStart), de = Math.min(this.w, dataEnd);
    if (de > ds) this.sha.update(this.buf.subarray(ds, de));
    if (crcType !== CRC_NONE) {
      const ce = blockEnd - crcLen(crcType); // CRC covers the block with its CRC value zeroed
      const cs = Math.max(at, start), cend = Math.min(this.w, ce);
      if (cend > cs) this.crc = crcType === CRC16 ? crc16x25Update(this.crc, this.buf, cs, cend) : crc32cUpdate(this.crc, this.buf, cs, cend);
    }
  }

  // Validate what arrived (the same checks decodeBundle makes) and return a received bundle.
  finish() {
    if (!this.buf || this.w !== this.buf.length) throw new Error("bundle truncated");
    const b = this.buf, P = this.p;
    if (b[b.length - 1] !== 0xff) throw new Error("trailing bytes after bundle");
    if (P.crcType !== CRC_NONE) {
      const n = crcLen(P.crcType);
      if (b[P.blockEnd - n - 1] !== (0x40 | n)) throw new Error("payload block CRC field malformed");
      let c = P.crcType === CRC16 ? crc16x25Update(this.crc, Buffer.alloc(n)) : crc32cUpdate(this.crc, Buffer.alloc(n));
      c = P.crcType === CRC16 ? (c ^ 0xffff) & 0xffff : (c ^ 0xffffffff) >>> 0;
      const got = P.crcType === CRC16 ? b.readUInt16BE(P.blockEnd - n) : b.readUInt32BE(P.blockEnd - n);
      if (got !== c) throw new Error(`block ${P.number} CRC mismatch`);
    }
    const [pr, ...ext] = this.raws;
    const pv = pr.value;
    if (!Array.isArray(pv) || pv[0] !== 7) throw new Error("not a BPv7 primary block");
    const [, flags, crcType, dest, source, reportTo, created] = pv;
    decodeEid(dest); decodeEid(reportTo); // validated as decodeBundle does
    const frag = flags & BUNDLE_FLAG.IS_FRAGMENT;
    if (pv.length !== 8 + (frag ? 2 : 0) + (crcType ? 1 : 0)) throw new Error("primary block has the wrong number of fields");
    if (!checkCrc(b.subarray(pr.start, pr.end), crcType, pv[pv.length - 1])) throw new Error("primary block CRC mismatch");
    const identity = [decodeEid(source), [created[0], created[1]]];
    if (frag) identity.push(pv[8], pv[9]);
    const nums = new Set([P.number]);
    const blocks = ext.map(({ start, end, value: bv }, i) => {
      const [type, number, , bcrc, data] = bv;
      if (!Buffer.isBuffer(data)) throw new Error(`block ${i + 1} data is not a byte string`);
      if ((bcrc ? 6 : 5) !== bv.length) throw new Error(`block ${i + 1} CRC field does not match its CRC type`);
      if (!checkCrc(b.subarray(start, end), bcrc, bv[5])) throw new Error(`block ${number} CRC mismatch`);
      if (nums.has(number)) throw new Error(`duplicate block number ${number}`);
      nums.add(number);
      return { type, number, start, end, data };
    });
    return { bytes: b, identity, primary: { start: pr.start, end: pr.end }, blocks, payload: { start: P.start, end: P.blockEnd, number: P.number }, payloadHash: this.sha.digest() };
  }
}

// Receive a complete buffer in one call (for callers that already hold the bytes).
export function receiveBundle(bytes, chunk = bytes.length) {
  const rx = new BundleReceiver();
  for (let i = 0; i < bytes.length; i += chunk) rx.push(bytes.subarray(i, i + chunk));
  return rx.finish();
}

// Cached CBOR of the receipt fields that repeat from bundle to bundle (keys 1 and 2).
const cache = new Map();
const cached = (key, value) => {
  const k = key + "\u0000" + value;
  let v = cache.get(k);
  if (!v) { if (cache.size > 4096) cache.clear(); v = Buffer.concat([encode(key), encode(value)]); cache.set(k, v); }
  return v;
};

// Sign a v2 receipt for a received bundle and return the outgoing bundle as a list of
// buffers: [0x9f + primary + other blocks, new block 224, payload block (a view, not a
// copy), 0xff]. `relay` is { kp: { priv, pub }, eid }; options as stampBundleV2.
export function stampReceivedParts(rx, relay, { prevHop, receivedAt, forwardedAt, subject } = {}) {
  const b = rx.bytes;
  const custody = rx.blocks.filter((x) => x.type === CUSTODY_BLOCK_TYPE);
  if (custody.length > 1) throw new Error("custody block malformed: more than one in the bundle");
  let itemsBytes = Buffer.alloc(0), count = 0;
  if (custody.length) {
    const items = decode(custody[0].data);
    if (!Array.isArray(items) || !items.length) throw new Error("custody block malformed");
    if (items.every((s) => typeof s === "string")) throw new Error("block 224 holds version 1 receipts; a block holds one version");
    if (!items.every((s) => Array.isArray(s))) throw new Error("custody block malformed: receipt versions mixed in one block");
    if (items.length >= MAX_RECEIPTS) throw new Error(`custody block full (${MAX_RECEIPTS} receipts)`);
    count = items.length;
    itemsBytes = custody[0].data.subarray(readHead(custody[0].data, 0).next); // the receipts as received
  }
  let prev = prevHop;
  if (!prev) {
    const pn = rx.blocks.find((x) => x.type === BLOCK.PREVIOUS_NODE);
    prev = pn ? decodeEid(decode(pn.data)) : null;
  }
  if (!prev) throw new Error("previous hop unknown: no Previous Node block and none supplied");
  const fields = [Buffer.from([0xa0 | (subject !== undefined ? 7 : 6)]),
    cached(1, prev), cached(2, relay.eid), encode(3), encode(rx.identity), encode(4), encode(bstr(rx.payloadHash)),
    encode(5), encode(receivedAt), encode(6), encode(forwardedAt)];
  if (subject !== undefined) fields.push(encode(7), encode(subject));
  const receipt = sign1Encoded(relay.kp.priv, Buffer.concat(fields));
  const n = count + 1, arrayHead = n < 24 ? Buffer.from([0x80 | n]) : Buffer.from([0x98, n]);
  const data = Buffer.concat([arrayHead, itemsBytes, receipt]);
  const used = new Set([rx.payload.number, ...rx.blocks.map((x) => x.number)]);
  let number = custody.length ? custody[0].number : 2;
  if (!custody.length) while (used.has(number)) number++;
  const block = sealBlock([CUSTODY_BLOCK_TYPE, number, BLOCK_FLAG.REPLICATE_IN_FRAGMENTS, CRC32C, bstr(data)], CRC32C);
  const head = Buffer.concat([Buffer.from([0x9f]), b.subarray(rx.primary.start, rx.primary.end),
    ...rx.blocks.filter((x) => x.type !== CUSTODY_BLOCK_TYPE).map((x) => b.subarray(x.start, x.end))]);
  return [head, block, b.subarray(rx.payload.start, rx.payload.end), Buffer.from([0xff])];
}

export const stampReceived = (rx, relay, opts) => Buffer.concat(stampReceivedParts(rx, relay, opts));
