// COSE_Sign1 (RFC 9052 section 4.2) with EdDSA over Ed25519 (RFC 9053 section 2.2,
// alg -8), untagged, no external AAD. Used by custody receipt version 2.
//
//   COSE_Sign1 = [ protected: bstr .cbor {1: -8}, unprotected: {}, payload: bstr, signature: bstr ]
//   signed bytes = CBOR ["Signature1", protected, h'', payload]
import { sign as nodeSign, verify as nodeVerify, createPublicKey } from "node:crypto";
import { encode, decode, bstr } from "./cbor.mjs";

export const ALG_EDDSA = -8;
const PROTECTED = encode(new Map([[1, ALG_EDDSA]]));

const toBeSigned = (prot, payload) => encode(["Signature1", bstr(prot), bstr(Buffer.alloc(0)), bstr(payload)]);

// Sign `payload` (bytes) with an Ed25519 KeyObject. Returns the COSE_Sign1 as a JS array
// ready to be CBOR-encoded inside a larger structure.
export function sign1(priv, payload) {
  const sig = nodeSign(null, toBeSigned(PROTECTED, payload), priv);
  return [bstr(PROTECTED), new Map(), bstr(payload), bstr(sig)];
}

// Check a decoded COSE_Sign1 against a base64 SPKI Ed25519 public key.
// { ok, payload } or { ok:false, reason }.
export function verify1(item, pubB64) {
  if (!Array.isArray(item) || item.length !== 4) return { ok: false, reason: "not_cose_sign1" };
  const [prot, unprot, payload, sig] = item;
  if (!Buffer.isBuffer(prot) || !(unprot instanceof Map) || !Buffer.isBuffer(payload) || !Buffer.isBuffer(sig)) {
    return { ok: false, reason: "not_cose_sign1" };
  }
  let headers;
  try { headers = decode(prot); } catch { return { ok: false, reason: "bad_protected_header" }; }
  if (!(headers instanceof Map) || headers.get(1) !== ALG_EDDSA) return { ok: false, reason: "unsupported_alg" };
  if (!pubB64) return { ok: false, reason: "custodian_not_pinned" };
  let ok = false;
  try {
    const pub = createPublicKey({ key: Buffer.from(pubB64, "base64"), format: "der", type: "spki" });
    ok = nodeVerify(null, toBeSigned(prot, payload), pub, sig);
  } catch { ok = false; }
  return ok ? { ok: true, payload } : { ok: false, reason: "signature_invalid" };
}
