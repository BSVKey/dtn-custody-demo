// Minimal CBOR (RFC 8949) for BPv7: unsigned/negative ints, byte and text strings,
// arrays (definite on encode; definite or indefinite on decode), maps, false/true/null.
// Encoding is deterministic (shortest-form heads), which is what RFC 9171 requires for
// everything except the outer bundle array, which is indefinite-length.

export class Bstr { constructor(bytes) { this.bytes = Buffer.from(bytes); } }
export const bstr = (b) => new Bstr(b);

// Marks the one place BPv7 uses an indefinite-length array: the bundle itself.
export class Indef { constructor(items) { this.items = items; } }

function head(major, n) {
  if (typeof n === "bigint") {
    if (n < 0n) throw new Error("negative length");
    if (n <= 0xffffffffn) n = Number(n);
    else { const b = Buffer.alloc(9); b[0] = (major << 5) | 27; b.writeBigUInt64BE(n, 1); return b; }
  }
  if (!Number.isInteger(n) || n < 0) throw new Error(`bad CBOR argument ${n}`);
  if (n < 24) return Buffer.from([(major << 5) | n]);
  if (n < 0x100) return Buffer.from([(major << 5) | 24, n]);
  if (n < 0x10000) { const b = Buffer.alloc(3); b[0] = (major << 5) | 25; b.writeUInt16BE(n, 1); return b; }
  if (n < 0x100000000) { const b = Buffer.alloc(5); b[0] = (major << 5) | 26; b.writeUInt32BE(n, 1); return b; }
  if (n > Number.MAX_SAFE_INTEGER) throw new Error("integer beyond 2^53, pass a BigInt");
  const b = Buffer.alloc(9); b[0] = (major << 5) | 27; b.writeBigUInt64BE(BigInt(n), 1); return b;
}

export function encode(v) {
  if (v === false) return Buffer.from([0xf4]);
  if (v === true) return Buffer.from([0xf5]);
  if (v === null) return Buffer.from([0xf6]);
  if (typeof v === "number" || typeof v === "bigint") {
    if (typeof v === "number" && !Number.isInteger(v)) throw new Error("floats are not used in BPv7");
    return v < 0 ? head(1, typeof v === "bigint" ? -1n - v : -1 - v) : head(0, v);
  }
  if (typeof v === "string") { const b = Buffer.from(v, "utf8"); return Buffer.concat([head(3, b.length), b]); }
  if (v instanceof Bstr) return Buffer.concat([head(2, v.bytes.length), v.bytes]);
  if (Buffer.isBuffer(v) || v instanceof Uint8Array) return encode(bstr(v));
  if (v instanceof Indef) return Buffer.concat([Buffer.from([0x9f]), ...v.items.map(encode), Buffer.from([0xff])]);
  if (Array.isArray(v)) return Buffer.concat([head(4, v.length), ...v.map(encode)]);
  if (v instanceof Map) {
    const parts = [head(5, v.size)];
    for (const [k, val] of v) parts.push(encode(k), encode(val));
    return Buffer.concat(parts);
  }
  throw new Error(`cannot CBOR-encode ${typeof v}`);
}

// Decode one item at `off`. Returns { value, end }. Byte strings come back as Buffer,
// indefinite arrays as Indef (so the caller can tell the bundle array apart).
export function decodeAt(buf, off = 0, depth = 0) {
  if (depth > 32) throw new Error("CBOR nesting too deep");
  if (off >= buf.length) throw new Error("CBOR truncated");
  const ib = buf[off], major = ib >> 5, ai = ib & 31;
  let p = off + 1, arg;
  const need = (n) => { if (p + n > buf.length) throw new Error("CBOR truncated"); };
  if (ai < 24) arg = ai;
  else if (ai === 24) { need(1); arg = buf[p]; p += 1; }
  else if (ai === 25) { need(2); arg = buf.readUInt16BE(p); p += 2; }
  else if (ai === 26) { need(4); arg = buf.readUInt32BE(p); p += 4; }
  else if (ai === 27) {
    need(8); const big = buf.readBigUInt64BE(p); p += 8;
    arg = big <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(big) : big;
  } else if (ai === 31) arg = null;
  else throw new Error(`CBOR reserved additional info ${ai}`);

  switch (major) {
    case 0: if (arg === null) throw new Error("indefinite uint"); return { value: arg, end: p };
    case 1: if (arg === null) throw new Error("indefinite nint");
      return { value: typeof arg === "bigint" ? -1n - arg : -1 - arg, end: p };
    case 2: case 3: {
      if (arg === null || typeof arg === "bigint") throw new Error("unsupported string length");
      need(arg); const s = buf.subarray(p, p + arg);
      return { value: major === 2 ? Buffer.from(s) : s.toString("utf8"), end: p + arg };
    }
    case 4: {
      const items = [];
      if (arg === null) {
        while (true) {
          if (p >= buf.length) throw new Error("CBOR truncated");
          if (buf[p] === 0xff) return { value: new Indef(items), end: p + 1 };
          const r = decodeAt(buf, p, depth + 1); items.push(r.value); p = r.end;
        }
      }
      for (let i = 0; i < arg; i++) { const r = decodeAt(buf, p, depth + 1); items.push(r.value); p = r.end; }
      return { value: items, end: p };
    }
    case 5: {
      if (arg === null) throw new Error("indefinite map not supported");
      const m = new Map();
      for (let i = 0; i < arg; i++) {
        const k = decodeAt(buf, p, depth + 1); const v = decodeAt(buf, k.end, depth + 1);
        m.set(k.value, v.value); p = v.end;
      }
      return { value: m, end: p };
    }
    case 7:
      if (ai === 20) return { value: false, end: p };
      if (ai === 21) return { value: true, end: p };
      if (ai === 22) return { value: null, end: p };
      throw new Error(`unsupported CBOR simple/float ${ai}`);
    default: throw new Error(`unsupported CBOR major type ${major}`);
  }
}

export function decode(buf) {
  const r = decodeAt(buf, 0);
  if (r.end !== buf.length) throw new Error("trailing bytes after CBOR item");
  return r.value;
}
