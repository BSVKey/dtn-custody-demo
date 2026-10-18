// BPv7 bundle codec (RFC 9171 section 4): primary block, canonical blocks, EIDs, and
// the block CRCs (CRC-16/X-25 and CRC-32C). Enough to read a bundle off the wire, add
// or replace an extension block, and write it back so any BPv7 node accepts it.
import { encode, decodeAt, bstr } from "./cbor.mjs";

// ---- CRCs (RFC 9171 section 4.2.1) ------------------------------------------------
function crcTable(poly, bits) {
  const t = new Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ poly : c >>> 1;
    t[i] = bits === 16 ? c & 0xffff : c >>> 0;
  }
  return t;
}
const T16 = crcTable(0x8408, 16), T32C = crcTable(0x82f63b78, 32);
export function crc16x25(buf) {
  let c = 0xffff;
  for (const b of buf) c = (c >>> 8) ^ T16[(c ^ b) & 0xff];
  return (c ^ 0xffff) & 0xffff;
}
export function crc32c(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = (c >>> 8) ^ T32C[(c ^ b) & 0xff];
  return (c ^ 0xffffffff) >>> 0;
}
export const CRC_NONE = 0, CRC16 = 1, CRC32C = 2;
const crcLen = (t) => (t === CRC16 ? 2 : t === CRC32C ? 4 : 0);

function crcBytes(type, data) {
  const out = Buffer.alloc(crcLen(type));
  if (type === CRC16) out.writeUInt16BE(crc16x25(data));
  else if (type === CRC32C) out.writeUInt32BE(crc32c(data));
  return out;
}

// Encode a block array whose last element is the CRC: compute over the block with a
// zeroed CRC field, then fill it in (section 4.2.1).
export function sealBlock(fields, type) {
  if (type === CRC_NONE) return encode(fields);
  const zeroed = encode([...fields, bstr(Buffer.alloc(crcLen(type)))]);
  return encode([...fields, bstr(crcBytes(type, zeroed))]);
}

// Re-encode a block array as received and check its CRC (decoded blocks are canonical
// CBOR in practice; we re-check against the original bytes, not our re-encoding).
function checkCrc(raw, type, crcValue) {
  if (type === CRC_NONE) return true;
  const n = crcLen(type);
  if (!Buffer.isBuffer(crcValue) || crcValue.length !== n) return false;
  const zeroed = Buffer.from(raw);
  zeroed.fill(0, raw.length - n);
  return crcBytes(type, zeroed).equals(crcValue);
}

// ---- Endpoint IDs (section 4.2.5.1) -----------------------------------------------
export function encodeEid(eid) {
  if (eid === "dtn:none") return [1, 0];
  let m = /^dtn:(\/\/.+)$/.exec(eid);
  if (m) return [1, m[1]];
  m = /^ipn:(\d+)\.(\d+)$/.exec(eid);
  if (m) return [2, [Number(m[1]), Number(m[2])]];
  throw new Error(`unsupported EID ${eid}`);
}
export function decodeEid(v) {
  if (!Array.isArray(v) || v.length !== 2) throw new Error("bad EID");
  const [scheme, ssp] = v;
  if (scheme === 1) return ssp === 0 ? "dtn:none" : `dtn:${ssp}`;
  if (scheme === 2 && Array.isArray(ssp) && ssp.length === 2) return `ipn:${ssp[0]}.${ssp[1]}`;
  throw new Error(`unsupported EID scheme ${scheme}`);
}

// ---- Block types and flags (sections 4.2.4, 4.3, 9.1) ------------------------------
export const BLOCK = { PAYLOAD: 1, PREVIOUS_NODE: 6, BUNDLE_AGE: 7, HOP_COUNT: 10, BIB: 11, BCB: 12 };
export const BLOCK_FLAG = {
  REPLICATE_IN_FRAGMENTS: 0x01,
  REPORT_IF_UNPROCESSED: 0x02,
  DELETE_BUNDLE_IF_UNPROCESSED: 0x04,
  DISCARD_BLOCK_IF_UNPROCESSED: 0x10,
};
export const BUNDLE_FLAG = { IS_FRAGMENT: 0x01, ADMIN_RECORD: 0x02, NO_FRAGMENT: 0x04 };

// ---- Bundle ------------------------------------------------------------------------
// Bundle shape:
// { primary: { flags, crcType, dest, source, reportTo, created:[dtnTimeMs, seq], lifetime,
//              fragmentOffset?, totalAduLength? },
//   blocks: [{ type, number, flags, crcType, data: Buffer }]   (payload block last) }
export function encodeBundle({ primary: p, blocks }) {
  const pf = [7, p.flags ?? 0, p.crcType ?? CRC32C, encodeEid(p.dest), encodeEid(p.source),
    encodeEid(p.reportTo ?? "dtn:none"), [p.created[0], p.created[1]], p.lifetime];
  if ((p.flags ?? 0) & BUNDLE_FLAG.IS_FRAGMENT) pf.push(p.fragmentOffset, p.totalAduLength);
  const parts = [sealBlock(pf, p.crcType ?? CRC32C)];
  if (!blocks.length || blocks[blocks.length - 1].type !== BLOCK.PAYLOAD) {
    throw new Error("the payload block must be the last block");
  }
  for (const b of blocks) {
    parts.push(sealBlock([b.type, b.number, b.flags ?? 0, b.crcType ?? CRC_NONE, bstr(b.data)], b.crcType ?? CRC_NONE));
  }
  return Buffer.concat([Buffer.from([0x9f]), ...parts, Buffer.from([0xff])]);
}

export function decodeBundle(buf) {
  if (buf[0] !== 0x9f) throw new Error("a bundle is an indefinite-length CBOR array");
  let off = 1;
  const raws = [];
  while (true) {
    if (off >= buf.length) throw new Error("bundle truncated");
    if (buf[off] === 0xff) { off++; break; }
    const r = decodeAt(buf, off);
    raws.push({ value: r.value, raw: buf.subarray(off, r.end) });
    off = r.end;
  }
  if (off !== buf.length) throw new Error("trailing bytes after bundle");
  if (raws.length < 2) throw new Error("a bundle needs a primary and a payload block");

  const pv = raws[0].value;
  if (!Array.isArray(pv) || pv[0] !== 7) throw new Error("not a BPv7 primary block");
  const [, flags, crcType, dest, source, reportTo, created, lifetime] = pv;
  const frag = flags & BUNDLE_FLAG.IS_FRAGMENT;
  const expectLen = 8 + (frag ? 2 : 0) + (crcType ? 1 : 0);
  if (pv.length !== expectLen) throw new Error("primary block has the wrong number of fields");
  if (!checkCrc(raws[0].raw, crcType, pv[pv.length - 1])) throw new Error("primary block CRC mismatch");
  const primary = {
    flags, crcType, dest: decodeEid(dest), source: decodeEid(source), reportTo: decodeEid(reportTo),
    created: [created[0], created[1]], lifetime,
  };
  if (frag) { primary.fragmentOffset = pv[8]; primary.totalAduLength = pv[9]; }

  const blocks = raws.slice(1).map(({ value: bv, raw }, i) => {
    if (!Array.isArray(bv) || (bv.length !== 5 && bv.length !== 6)) throw new Error(`block ${i + 1} malformed`);
    const [type, number, bflags, bcrc, data] = bv;
    if (!Buffer.isBuffer(data)) throw new Error(`block ${i + 1} data is not a byte string`);
    if ((bcrc ? 6 : 5) !== bv.length) throw new Error(`block ${i + 1} CRC field does not match its CRC type`);
    if (!checkCrc(raw, bcrc, bv[5])) throw new Error(`block ${number} CRC mismatch`);
    return { type, number, flags: bflags, crcType: bcrc, data };
  });
  if (blocks[blocks.length - 1].type !== BLOCK.PAYLOAD) throw new Error("the payload block must be last");
  const nums = new Set();
  for (const b of blocks) {
    if (nums.has(b.number)) throw new Error(`duplicate block number ${b.number}`);
    nums.add(b.number);
  }
  return { primary, blocks };
}

export const payloadOf = (bundle) => bundle.blocks.find((b) => b.type === BLOCK.PAYLOAD).data;

// Lowest free block number above 1 (the payload is always number 1).
export function nextBlockNumber(bundle) {
  const used = new Set(bundle.blocks.map((b) => b.number));
  let n = 2;
  while (used.has(n)) n++;
  return n;
}

// Insert or replace an extension block (before the payload, which stays last).
export function putBlock(bundle, block) {
  const blocks = bundle.blocks.filter((b) => b.type !== block.type);
  const existing = bundle.blocks.find((b) => b.type === block.type);
  const number = existing ? existing.number : nextBlockNumber(bundle);
  const payload = blocks.pop();
  return { ...bundle, blocks: [...blocks, { ...block, number }, payload] };
}
