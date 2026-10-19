// COSE_Sign1 (RFC 9052 section 4.2) with EdDSA over Ed25519 (RFC 9053 section 2.2,
// alg -8), untagged. Used by custody receipt version 2 and by signed TREB hop-records.
//
//   COSE_Sign1 = [ protected: bstr .cbor {1: -8}, unprotected: {}, payload: bstr / nil, signature: bstr ]
//   signed bytes = CBOR ["Signature1", protected, external_aad, payload]
//
// A detached signature (RFC 9052 section 4.1) carries nil in place of the payload: the verifier
// supplies the payload bytes it already holds. external_aad binds data that is not carried in
// the structure at all, such as the bundle a hop-record describes.
import { sign as nodeSign, verify as nodeVerify, createPublicKey } from "node:crypto";
import { encode, decode, bstr } from "./cbor.mjs";

export const ALG_EDDSA = -8;
const PROTECTED = encode(new Map([[1, ALG_EDDSA]]));
const EMPTY = Buffer.alloc(0);

// Sig_structure. With the usual protected header and no external_aad, everything before the
// payload is constant, so it is encoded once (the same bytes the generic encoder produces).
const SIG1_PREFIX = Buffer.concat([Buffer.from([0x84]), encode("Signature1"), encode(bstr(PROTECTED)), encode(bstr(EMPTY))]);
export function toBeSigned(prot, payload, aad = EMPTY) {
  if (aad.length === 0 && prot.equals(PROTECTED)) return Buffer.concat([SIG1_PREFIX, encode(bstr(payload))]);
  return encode(["Signature1", bstr(prot), bstr(aad), bstr(payload)]);
}

// The encoded COSE_Sign1 of `payload`, built directly: the same bytes as encode(sign1(priv, payload)).
const SIGN1_HEAD = Buffer.concat([Buffer.from([0x84]), encode(bstr(PROTECTED)), Buffer.from([0xa0])]);
const SIG_HEAD = Buffer.from([0x58, 0x40]);
export function sign1Encoded(priv, payload) {
  const sig = nodeSign(null, toBeSigned(PROTECTED, payload), priv);
  return Buffer.concat([SIGN1_HEAD, encode(bstr(payload)), SIG_HEAD, sig]);
}

// Sign `payload` (bytes) with an Ed25519 KeyObject. Returns the COSE_Sign1 as a JS array
// ready to be CBOR-encoded inside a larger structure. { detached: true } leaves the payload out.
export function sign1(priv, payload, { aad = EMPTY, detached = false } = {}) {
  const sig = nodeSign(null, toBeSigned(PROTECTED, payload, aad), priv);
  return [bstr(PROTECTED), new Map(), detached ? null : bstr(payload), bstr(sig)];
}

// Check a decoded COSE_Sign1 against a base64 SPKI Ed25519 public key. A detached signature
// needs { payload }. { ok, payload } or { ok:false, reason }.
export function verify1(item, pubB64, { aad = EMPTY, payload: detachedPayload } = {}) {
  if (!Array.isArray(item) || item.length !== 4) return { ok: false, reason: "not_cose_sign1" };
  const [prot, unprot, carried, sig] = item;
  if (!Buffer.isBuffer(prot) || !(unprot instanceof Map) || !Buffer.isBuffer(sig)) return { ok: false, reason: "not_cose_sign1" };
  if (carried !== null && !Buffer.isBuffer(carried)) return { ok: false, reason: "not_cose_sign1" };
  const payload = carried ?? (detachedPayload ? Buffer.from(detachedPayload) : null);
  if (!payload) return { ok: false, reason: "detached_payload_missing" };
  let headers;
  try { headers = decode(prot); } catch { return { ok: false, reason: "bad_protected_header" }; }
  if (!(headers instanceof Map) || headers.get(1) !== ALG_EDDSA) return { ok: false, reason: "unsupported_alg" };
  if (!pubB64) return { ok: false, reason: "custodian_not_pinned" };
  let ok = false;
  try {
    const pub = createPublicKey({ key: Buffer.from(pubB64, "base64"), format: "der", type: "spki" });
    ok = nodeVerify(null, toBeSigned(prot, payload, aad), pub, sig);
  } catch { ok = false; }
  return ok ? { ok: true, payload } : { ok: false, reason: "signature_invalid" };
}
