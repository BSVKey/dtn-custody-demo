// BPSec (RFC 9172) Block Integrity Block with the BIB-HMAC-SHA2 security context
// (RFC 9173 section 3, context id 1): build and verify a BIB over chosen target blocks.
// Checked byte for byte against RFC 9173 Appendix A.1 (test/bpv7-bpsec.test.mjs).
//
// Used here to show that a payload BIB is untouched when custodians append to the
// Custody Receipt Block (type 224): the BIB never targets block 224, and appending a
// receipt changes nothing the BIB covers.
import { createHmac, createDecipheriv, timingSafeEqual } from "node:crypto";
import { encode, decodeAt, bstr } from "./cbor.mjs";
import { encodeBundle, encodeEid, decodeEid, sealBlock, BLOCK, CRC_NONE, nextBlockNumber } from "./bundle.mjs";

export const SC_BIB_HMAC_SHA2 = 1;
export const SHA = { HMAC256: 5, HMAC384: 6, HMAC512: 7 };
const HASH = { 5: "sha256", 6: "sha384", 7: "sha512" };
export const SCOPE = { PRIMARY: 0x1, TARGET_HEADER: 0x2, SECURITY_HEADER: 0x4 };
const PARAM = { SHA_VARIANT: 1, WRAPPED_KEY: 2, SCOPE_FLAGS: 3 };
const RESULT_MAC = 1;

// The primary block exactly as it goes on the wire (RFC 9172 section 4: canonical form),
// CRC included: the first item of the encoded bundle.
function primaryBytes(bundle) {
  const all = encodeBundle(bundle);
  return all.subarray(1, decodeAt(all, 1).end);
}

const uints = (...ns) => Buffer.concat(ns.map((n) => encode(n)));

// Integrity-protected plaintext, RFC 9173 section 3.7. When the target is the primary
// block, steps 2 and 3 are skipped and the primary block is appended as a CBOR byte string
// (as in the Appendix A.3 vector); any other target's data is appended as a byte string.
//
// mode "ion": JPL ION (c5a4d87, bpv7/bpsec/utils/bpsec_util.c canonicalizePayloadBlock)
// appends the whole serialized target block instead (header with flags 0, data, CRC),
// so its MACs differ from RFC 9173 for every non-primary target. Found and confirmed
// live 2026-10-18 (transport/bpv7/RESULTS.md); kept only to interoperate with ION.
export const IPPT_MODE = { RFC9173: "rfc9173", ION: "ion" };
export function ippt(bundle, target, bib, scope, mode = IPPT_MODE.RFC9173) {
  const parts = [encode(scope & 0x7)];
  const isPrimary = target.number === 0;
  if (!isPrimary && scope & SCOPE.PRIMARY) parts.push(primaryBytes(bundle));
  if (!isPrimary && scope & SCOPE.TARGET_HEADER) parts.push(uints(target.type, target.number, target.flags ?? 0));
  if (scope & SCOPE.SECURITY_HEADER) parts.push(uints(BLOCK.BIB, bib.number, bib.flags ?? 0));
  if (mode === IPPT_MODE.ION && !isPrimary) {
    parts.push(sealBlock([target.type, target.number, 0, target.crcType ?? CRC_NONE, bstr(target.data)], target.crcType ?? CRC_NONE));
  } else {
    parts.push(encode(bstr(isPrimary ? primaryBytes(bundle) : target.data)));
  }
  return Buffer.concat(parts);
}

const mac = (variant, key, data) => createHmac(HASH[variant], key).update(data).digest();

// RFC 9173 section 3.3.2: a BIB may carry its HMAC key wrapped (AES Key Wrap, RFC 3394)
// under the shared long-term key; JPL ION does this when it signs. Unwrap with the
// long-term key; a wrong key fails the RFC 3394 integrity check and throws.
export function unwrapKey(kek, wrapped) {
  const alg = { 16: "id-aes128-wrap", 24: "id-aes192-wrap", 32: "id-aes256-wrap" }[kek.length];
  if (!alg) throw new Error(`no AES key wrap for a ${kek.length}-byte key`);
  const d = createDecipheriv(alg, kek, Buffer.from("A6A6A6A6A6A6A6A6", "hex"));
  return Buffer.concat([d.update(Buffer.from(wrapped)), d.final()]);
}

// Add a BIB over `targets` (block numbers; 0 = primary). Returns a new bundle object.
// RFC 9173 section 3.8.1: a target's CRC MUST be removed before the IPPT is computed (the
// BIB now protects it); Hardy refuses a bundle whose BIB target still carries one.
export function addBib(bundle0, { targets, key, source, shaVariant = SHA.HMAC256, scope = 0x7, flags = 0, crcType = CRC_NONE, number, mode = IPPT_MODE.RFC9173 }) {
  if (!HASH[shaVariant]) throw new Error(`unknown SHA variant ${shaVariant}`);
  const bundle = {
    primary: targets.includes(0) ? { ...bundle0.primary, crcType: CRC_NONE } : bundle0.primary,
    blocks: bundle0.blocks.map((b) => (targets.includes(b.number) ? { ...b, crcType: CRC_NONE } : b)),
  };
  const bibNumber = number ?? nextBlockNumber(bundle);
  const bib = { number: bibNumber, flags };
  const results = targets.map((n) => {
    const t = n === 0 ? { number: 0 } : bundle.blocks.find((b) => b.number === n);
    if (!t) throw new Error(`no block ${n} to target`);
    if (t.type === BLOCK.BIB || t.type === BLOCK.BCB) throw new Error("a BIB must not target a security block");
    return [[RESULT_MAC, bstr(mac(shaVariant, key, ippt(bundle, t, bib, scope, mode)))]];
  });
  const asb = Buffer.concat([
    encode(targets), encode(SC_BIB_HMAC_SHA2), encode(1), encode(encodeEid(source)),
    encode([[PARAM.SHA_VARIANT, shaVariant], [PARAM.SCOPE_FLAGS, scope]]),
    encode(results),
  ]);
  const blocks = [...bundle.blocks];
  const payload = blocks.pop();
  return { ...bundle, blocks: [...blocks, { type: BLOCK.BIB, number: bibNumber, flags, crcType, data: asb }, payload] };
}

// Parse a BIB's abstract security block (RFC 9172 section 3.6: a CBOR sequence).
export function parseAsb(data) {
  let off = 0;
  const next = () => { const r = decodeAt(data, off); off = r.end; return r.value; };
  const targets = next(), contextId = next(), contextFlags = next(), source = decodeEid(next());
  const params = contextFlags & 1 ? new Map(next().map(([k, v]) => [k, v])) : new Map();
  const results = next();
  if (off !== data.length) throw new Error("trailing bytes in security block");
  return { targets, contextId, contextFlags, source, params, results };
}

// Verify every BIB in the bundle with `key`. { ok, bibs: [{ number, source, targets }] }
// or { ok:false, reason, ... }. mode "ion" verifies a BIB made by JPL ION, which also
// keeps the target's CRC, so that check is relaxed in that mode only.
export function verifyBibs(bundle, key, { mode = IPPT_MODE.RFC9173 } = {}) {
  const bibs = bundle.blocks.filter((b) => b.type === BLOCK.BIB);
  if (!bibs.length) return { ok: false, reason: "no_bib" };
  const out = [];
  for (const b of bibs) {
    let asb;
    try { asb = parseAsb(b.data); } catch (e) { return { ok: false, reason: "bib_malformed", detail: e.message }; }
    if (asb.contextId !== SC_BIB_HMAC_SHA2) return { ok: false, reason: "unsupported_security_context", context: asb.contextId };
    // RFC 9173 section 3.3.1: the default SHA variant is HMAC 384/384. ION signs with
    // HMAC 256/256 and omits the parameter, so in ion mode its default is used.
    const variant = asb.params.get(PARAM.SHA_VARIANT) ?? (mode === IPPT_MODE.ION ? SHA.HMAC256 : SHA.HMAC384);
    const scope = asb.params.get(PARAM.SCOPE_FLAGS) ?? 0x7;
    let macKey = key;
    if (asb.params.has(PARAM.WRAPPED_KEY)) {
      try { macKey = unwrapKey(key, asb.params.get(PARAM.WRAPPED_KEY)); } catch { return { ok: false, reason: "key_unwrap_failed", bib: b.number }; }
    }
    for (let i = 0; i < asb.targets.length; i++) {
      const n = asb.targets[i];
      const t = n === 0 ? { number: 0 } : bundle.blocks.find((x) => x.number === n);
      if (!t) return { ok: false, reason: "target_missing", bib: b.number, target: n };
      if (mode !== IPPT_MODE.ION && (n === 0 ? bundle.primary.crcType : t.crcType) !== CRC_NONE) {
        return { ok: false, reason: "target_has_crc", bib: b.number, target: n }; // RFC 9173 3.8.1
      }
      const r = (asb.results[i] || []).find(([id]) => id === RESULT_MAC);
      if (!r) return { ok: false, reason: "no_mac_result", bib: b.number, target: n };
      const want = mac(variant, macKey, ippt(bundle, t, b, scope, mode));
      const got = Buffer.from(r[1]);
      if (got.length !== want.length || !timingSafeEqual(got, want)) {
        return { ok: false, reason: "mac_mismatch", bib: b.number, target: n };
      }
    }
    out.push({ number: b.number, source: asb.source, targets: asb.targets });
  }
  return { ok: true, bibs: out };
}
