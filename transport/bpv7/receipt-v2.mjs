// Custody receipt version 2, carried in the same Custody Receipt Block (type 224):
// a CBOR payload signed as a COSE_Sign1 (EdDSA, Ed25519), bound to the BPv7 bundle
// identity and to a digest of the payload bytes the custodian held.
//
// Version 1 receipts (canonical JSON text strings, custody-block.mjs) stay valid and are
// not changed. One block holds one version: an array of text strings is version 1, an
// array of COSE_Sign1 arrays is version 2. Mixing them in one block is refused.
//
// Receipt payload (CBOR map, integer keys):
//   1 prevHop      tstr   EID the custodian received the bundle from
//   2 thisHop      tstr   EID of the custodian (its key is pinned by the verifier)
//   3 bundle       array  [source EID, [creation time, sequence]] or, when the custodian
//                         held a fragment, [source, [time, seq], fragment offset, total ADU length]
//   4 payloadHash  bstr   SHA-256 of the payload block's block-type-specific data it held
//   5 receivedAt   uint   DTN time (ms since 2000-01-01T00:00:00Z)
//   6 forwardedAt  uint   DTN time
//   7 subject      tstr   optional application identifier (for example a v1 bundleId)
//   8 hopCount     array  optional [hop count as received, hop count as released]: from the
//                         RFC 9171 Hop Count block, so a verifier can size an unsigned gap
//                         (next.received - prev.released plain forwarders in between)
//   9 chain        bstr   optional SHA-256 of the CBOR array of the receipts already in the
//                         block: commits this receipt to every earlier one, so a later
//                         custodian witnesses that they existed when it signed
//
// No custodian parses the payload: it hashes the bytes it holds. Any verifier can check
// the binding from the primary block and payload alone, with no application knowledge.
import { createHash } from "node:crypto";
import { encode, decode, bstr } from "./cbor.mjs";
import { decodeBundle, encodeBundle, putBlock, payloadOf, BLOCK, BLOCK_FLAG, BUNDLE_FLAG, CRC32C } from "./bundle.mjs";
import { CUSTODY_BLOCK_TYPE, previousNode } from "./custody-block.mjs";
import { sign1, verify1 } from "./cose.mjs";

const K = { PREV: 1, THIS: 2, BUNDLE: 3, HASH: 4, RECV: 5, FWD: 6, SUBJECT: 7, HOPS: 8, CHAIN: 9 };
const chainDigest = (items) => createHash("sha256").update(encode(items)).digest();
function hopCountOf(bundle) {
  const b = bundle.blocks.find((x) => x.type === BLOCK.HOP_COUNT);
  if (!b) return null;
  const v = decode(b.data);
  return Array.isArray(v) && Number.isInteger(v[1]) ? v[1] : null;
}
export const MAX_RECEIPTS = 64;

// The BPv7 bundle identity (RFC 9171 section 4.3.1 and 5.8): source, creation timestamp,
// and for a fragment its offset and the total application data unit length.
export function bundleIdentity(bundle) {
  const p = bundle.primary;
  const id = [p.source, [p.created[0], p.created[1]]];
  if ((p.flags ?? 0) & BUNDLE_FLAG.IS_FRAGMENT) id.push(p.fragmentOffset, p.totalAduLength);
  return id;
}
const sameId = (a, b) => JSON.stringify(a) === JSON.stringify(b);
export const payloadHash = (bundle) => createHash("sha256").update(payloadOf(bundle)).digest();

// The block's items, and which version they are: { version: 0 (none) | 1 | 2, items }.
export function readBlockItems(bundle) {
  const all = bundle.blocks.filter((x) => x.type === CUSTODY_BLOCK_TYPE);
  if (all.length > 1) throw new Error("custody block malformed: more than one in the bundle");
  if (!all.length) return { version: 0, items: [] };
  const items = decode(all[0].data);
  if (!Array.isArray(items) || !items.length) throw new Error("custody block malformed");
  if (items.every((s) => typeof s === "string")) return { version: 1, items };
  if (items.every((s) => Array.isArray(s))) return { version: 2, items };
  throw new Error("custody block malformed: receipt versions mixed in one block");
}

// Decode a v2 receipt's payload without checking its signature (used to find thisHop).
export function receiptFields(item) {
  const m = decode(item[2]);
  if (!(m instanceof Map)) throw new Error("receipt payload is not a map");
  return {
    prevHop: m.get(K.PREV), thisHop: m.get(K.THIS), bundle: m.get(K.BUNDLE), payloadHash: m.get(K.HASH),
    receivedAt: m.get(K.RECV), forwardedAt: m.get(K.FWD), subject: m.get(K.SUBJECT),
    hopCount: m.get(K.HOPS), chain: m.get(K.CHAIN),
  };
}

// Custodian step on raw bundle bytes: sign a v2 receipt for the bundle (or fragment) as
// held, append it to block 224, re-encode. `relay` is { kp: { priv, pub }, eid }.
// Options: chain (add field 9), hops (add field 8 from the Hop Count block if present;
// hopsReleased when this custodian is a forwarder that increments the count itself).
export function stampBundleV2(bytes, relay, { prevHop, receivedAt, forwardedAt, subject, chain = false, hops = false, hopsReleased } = {}) {
  const bundle = decodeBundle(bytes);
  const { version, items } = readBlockItems(bundle);
  if (version === 1) throw new Error("block 224 holds version 1 receipts; a block holds one version");
  if (items.length >= MAX_RECEIPTS) throw new Error(`custody block full (${MAX_RECEIPTS} receipts)`);
  const prev = prevHop ?? previousNode(bundle);
  if (!prev) throw new Error("previous hop unknown: no Previous Node block and none supplied");
  const fields = new Map([
    [K.PREV, prev], [K.THIS, relay.eid], [K.BUNDLE, bundleIdentity(bundle)],
    [K.HASH, bstr(payloadHash(bundle))], [K.RECV, receivedAt], [K.FWD, forwardedAt],
  ]);
  if (subject !== undefined) fields.set(K.SUBJECT, subject);
  const hc = hops ? hopCountOf(bundle) : null;
  if (hc !== null) fields.set(K.HOPS, [hc, hopsReleased ?? hc]);
  if (chain) fields.set(K.CHAIN, bstr(chainDigest(items)));
  const receipt = sign1(relay.kp.priv, encode(fields));
  const data = encode([...items, receipt]);
  return encodeBundle(putBlock(bundle, { type: CUSTODY_BLOCK_TYPE, flags: BLOCK_FLAG.REPLICATE_IN_FRAGMENTS, crcType: CRC32C, data }));
}

// Destination (or any later auditor) check of a v2 chain on raw bundle bytes.
//   keys      { eid: base64 SPKI } the verifier's own pinned custodian keys
//   origin    optional EID the first receipt should name as prevHop
//   lastNode  optional EID that delivered the bundle (default: its Previous Node block)
//   hops      optional pinned route [eid, ...]: the custodians must be exactly these, in order
//   keyring   instead of keys: a Keyring (keyring.mjs) holding the verifier's anchors and the
//             records it has seen (ingest the bundle's block 225 first). Keys are then found
//             by EID and checked for role, validity window and revocation at signing time.
//   arrivedAt the verifier's own clock when the bundle arrived (DTN ms), a time witness
// Every receipt present must verify under the key pinned for its thisHop and name this
// bundle's identity (a whole-bundle receipt also covers its fragments). Where a receipt
// is for exactly what was received (the same fragment, or the whole bundle), its payload
// hash must match the bytes received; a whole-bundle receipt seen in a fragment cannot be
// hash-checked here and is listed in hashUnchecked. Unsigned stretches are gaps, sized
// from field 8 where both sides carry it. A receipt signed with a key revoked from T must
// claim a time before T and be witnessed before T: by a later receipt whose field 9 commits
// to it, signed with an unrevoked key, received before T; or by arrivedAt before T.
export function verifyBundleV2(bytes, { keys, keyring, arrivedAt, origin = null, lastNode, hops } = {}) {
  let bundle;
  try { bundle = decodeBundle(bytes); } catch (e) { return { ok: false, reason: "bundle_malformed", detail: e.message }; }
  let block;
  try { block = readBlockItems(bundle); } catch { return { ok: false, reason: "custody_block_malformed" }; }
  if (block.version === 0) return { ok: false, reason: "no_custody_block" };
  if (block.version !== 2) return { ok: false, reason: "not_version_2" };
  if (block.items.length > MAX_RECEIPTS) return { ok: false, reason: "too_many_receipts" };
  const id = bundleIdentity(bundle), whole = id.slice(0, 2), hash = payloadHash(bundle);
  if (hops && hops.length !== block.items.length) return { ok: false, reason: "wrong_hop_count" };
  const gaps = [], hashUnchecked = [], fields = [], keyState = [];
  let prevEid = origin, prevHops = null;
  for (let i = 0; i < block.items.length; i++) {
    let f;
    try { f = receiptFields(block.items[i]); } catch { return { ok: false, reason: "receipt_malformed", hop: i }; }
    fields.push(f);
    if (f.chain !== undefined && !(Buffer.isBuffer(f.chain) && f.chain.equals(chainDigest(block.items.slice(0, i))))) {
      return { ok: false, reason: "chain_digest_mismatch", hop: i };
    }
    if (keyring) {
      const cands = keyring.pubsFor(f.thisHop);
      if (!cands.length) return { ok: false, reason: "custodian_key_unknown", hop: i };
      const pub = cands.find((p) => verify1(block.items[i], p).ok);
      if (!pub) return { ok: false, reason: "signature_invalid", hop: i };
      const st = keyring.status(pub, f.thisHop, f.forwardedAt ?? f.receivedAt);
      if (!st.ok) return { ok: false, reason: st.reason, hop: i };
      keyState.push(st);
    } else {
      const v = verify1(block.items[i], keys[f.thisHop]);
      if (!v.ok) return { ok: false, reason: v.reason, hop: i };
    }
    if (hops && f.thisHop !== hops[i]) return { ok: false, reason: "unexpected_hop", hop: i };
    if (sameId(f.bundle, id)) {
      if (!Buffer.isBuffer(f.payloadHash) || !f.payloadHash.equals(hash)) return { ok: false, reason: "payload_hash_mismatch", hop: i };
    } else if (id.length === 4 && sameId(f.bundle, whole)) {
      hashUnchecked.push(i);
    } else {
      return { ok: false, reason: "wrong_bundle", hop: i };
    }
    const sized = (gap, inCount) => (prevHops && inCount !== null && inCount !== undefined ? { ...gap, unsignedNodes: inCount - prevHops[1] } : gap);
    if (prevEid !== null && f.prevHop !== prevEid) {
      if (hops) return { ok: false, reason: "custody_chain_break", hop: i };
      gaps.push(sized({ afterHop: prevEid, beforeHop: f.thisHop, lastUnsigned: f.prevHop }, f.hopCount?.[0]));
    } else if (prevHops && f.hopCount && f.hopCount[0] - prevHops[1] > 0) {
      // Same previous hop named, yet the count says plain forwarders stood in between.
      gaps.push({ afterHop: prevEid, beforeHop: f.thisHop, lastUnsigned: null, unsignedNodes: f.hopCount[0] - prevHops[1] });
    }
    prevEid = f.thisHop;
    prevHops = Array.isArray(f.hopCount) ? f.hopCount : null;
  }
  const last = lastNode !== undefined ? lastNode : previousNode(bundle);
  if (last && last !== prevEid) {
    const now = hopCountOf(bundle);
    gaps.push(prevHops && now !== null ? { afterHop: prevEid, beforeHop: null, lastUnsigned: last, unsignedNodes: now - prevHops[1] }
      : { afterHop: prevEid, beforeHop: null, lastUnsigned: last });
  }
  // Revoked keys: the signature must claim a time before the revocation and be witnessed then.
  const witnessed = [];
  for (let i = 0; i < keyState.length; i++) {
    const T = keyState[i].revokedFrom;
    if (T === null || T === undefined) continue;
    const t = fields[i].forwardedAt ?? fields[i].receivedAt;
    if (!(t < T)) return { ok: false, reason: "signed_after_revocation", hop: i, revokedFrom: T };
    let by = null;
    for (let j = i + 1; j < keyState.length && by === null; j++) {
      if (fields[j].chain !== undefined && keyState[j].revokedFrom === null && fields[j].receivedAt < T) by = { hop: j, eid: fields[j].thisHop };
    }
    if (by === null && arrivedAt !== undefined && arrivedAt < T) by = { verifierArrival: arrivedAt };
    if (by === null) return { ok: false, reason: "revoked_unwitnessed", hop: i, revokedFrom: T };
    witnessed.push({ hop: i, revokedFrom: T, witnessedBy: by });
  }
  const out = { ok: true, complete: gaps.length === 0, custodied: block.items.length, gaps, hashUnchecked, bundle: id };
  if (keyring) { out.keys = keyState.map((s) => ({ keyId: s.keyId, anchor: s.anchor, revokedFrom: s.revokedFrom })); out.witnessed = witnessed; }
  return out;
}
