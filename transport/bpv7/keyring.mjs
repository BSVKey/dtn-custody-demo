// Offline key management for custody receipts: who may sign for which node, from when to
// when, and what happens when a key is lost, without any online authority.
//
// Records are COSE_Sign1 (EdDSA) over a CBOR map with integer keys, the same envelope as
// receipt version 2:
//
//   key record     1 kind = 1         2 subject EID     3 public key (32-byte Ed25519)
//                  4 roles (bits: 1 custody, 2 issue, 4 revoke)
//                  5 notBefore        6 notAfter        7 issuedAt (DTN ms)
//                  8 issuer key id    9 replaces key id (optional, rotation)
//   revocation     1 kind = 2        10 revoked key id 11 effectiveFrom (DTN ms: the earliest
//                  moment the key may have been out of its holder's control)
//                 12 reason          7 issuedAt         8 issuer key id
//
// A key id is the first 16 bytes of SHA-256 of the raw public key. Trust starts from
// anchors the verifier holds (one per operator); everything else is a record that chains to
// an anchor through keys with the issue role. Records travel inside bundles, in the Key
// Record Block (type 225), so a verifier needs nothing but its anchors.
//
// Rules a verifier applies, all offline:
// - A key record counts if its issuer is an anchor or a valid key with the issue role at
//   the record's issuedAt, and the signature verifies. If the issuer has since been revoked
//   from time T, records it signed count only if this keyring held them before T (a stolen
//   issuer key can backdate issuedAt, so only the keyring's own clock is trusted for this).
// - A revocation counts if it is signed by the revoked key itself (self-revocation), by any
//   key in that key's issuing chain, by an anchor, or by a key with the revoke role chaining
//   to the same anchor. Revocations are never undone; the earliest effectiveFrom wins.
// - A signature made with a revoked key and claiming a time before effectiveFrom is accepted
//   only if something trustworthy witnessed it before effectiveFrom (receipt-v2.mjs: a later
//   custodian whose receipt commits to it, or the verifier's own arrival time).
import { createHash } from "node:crypto";
import { encode, decode, bstr } from "./cbor.mjs";
import { sign1, verify1 } from "./cose.mjs";
import { decodeBundle, encodeBundle, putBlock, BLOCK_FLAG, CRC32C } from "./bundle.mjs";

export const KEY_BLOCK_TYPE = 225;
export const ROLE = { CUSTODY: 1, ISSUE: 2, REVOKE: 4 };
export const KIND = { KEY: 1, REVOKE: 2 };
export const MAX_BLOCK_RECORDS = 32;
const F = { KIND: 1, SUBJECT: 2, PUB: 3, ROLES: 4, NB: 5, NA: 6, ISSUED: 7, ISSUER: 8, REPLACES: 9, TARGET: 10, FROM: 11, REASON: 12 };
const MAX_DEPTH = 6;

// ---- Keys and ids ---------------------------------------------------------------------
const SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");
export const rawPub = (spkiB64) => Buffer.from(spkiB64, "base64").subarray(SPKI_PREFIX.length);
export const spkiOf = (raw) => Buffer.concat([SPKI_PREFIX, raw]).toString("base64");
export const keyIdOf = (spkiB64) => createHash("sha256").update(rawPub(spkiB64)).digest().subarray(0, 16);
const hex = (b) => Buffer.from(b).toString("hex");
const recordHash = (item) => createHash("sha256").update(encode(item)).digest("hex");

// ---- Issuing records (operator side) ---------------------------------------------------
// issuer: { priv, pub } (pub base64 SPKI). Returns the COSE_Sign1 item.
export function issueKey(issuer, { subject, pub, roles = ROLE.CUSTODY, notBefore, notAfter, issuedAt = notBefore, replaces }) {
  const m = new Map([
    [F.KIND, KIND.KEY], [F.SUBJECT, subject], [F.PUB, bstr(rawPub(pub))], [F.ROLES, roles],
    [F.NB, notBefore], [F.NA, notAfter], [F.ISSUED, issuedAt], [F.ISSUER, bstr(keyIdOf(issuer.pub))],
  ]);
  if (replaces) m.set(F.REPLACES, bstr(keyIdOf(replaces)));
  return asCarried(sign1(issuer.priv, encode(m)));
}

// signer may be the key being revoked (self-revocation) or anyone allowed to revoke it.
export function revokeKey(signer, { target, effectiveFrom, reason = "compromised", issuedAt = effectiveFrom }) {
  return asCarried(sign1(signer.priv, encode(new Map([
    [F.KIND, KIND.REVOKE], [F.TARGET, bstr(keyIdOf(target))], [F.FROM, effectiveFrom],
    [F.REASON, reason], [F.ISSUED, issuedAt], [F.ISSUER, bstr(keyIdOf(signer.pub))],
  ]))));
}

// Records are handled in the form they have after crossing the wire (plain byte buffers).
const asCarried = (item) => decode(encode(item));

export function recordFields(item) {
  const m = decode(item[2]);
  if (!(m instanceof Map)) throw new Error("record payload is not a map");
  const g = (k) => m.get(k);
  return {
    kind: g(F.KIND), subject: g(F.SUBJECT), pub: g(F.PUB), roles: g(F.ROLES) ?? 0,
    notBefore: g(F.NB), notAfter: g(F.NA), issuedAt: g(F.ISSUED), issuer: g(F.ISSUER),
    replaces: g(F.REPLACES), target: g(F.TARGET), effectiveFrom: g(F.FROM), reason: g(F.REASON),
  };
}

// ---- The verifier's keyring ------------------------------------------------------------
// anchors: [{ name, eid?, pub }]: the operators' root keys, held out of band.
export class Keyring {
  constructor({ anchors = [], skewMs = 0 } = {}) {
    this.anchors = new Map(anchors.map((a) => [hex(keyIdOf(a.pub)), a]));
    this.skewMs = skewMs;
    this.records = new Map(); // record hash -> { item, f, seenAt }
  }

  // Add a record as seen at local time seenAt (the keyring's own clock, DTN ms). Records
  // are kept even if they do not verify yet (their issuer may arrive later); validity is
  // decided when a key is looked up. Returns false for duplicates and unreadable items.
  add(item, seenAt) {
    let f;
    try { f = recordFields(item); } catch { return false; }
    if (f.kind !== KIND.KEY && f.kind !== KIND.REVOKE) return false;
    const h = recordHash(item);
    if (this.records.has(h)) {
      const r = this.records.get(h);
      if (seenAt < r.seenAt) r.seenAt = seenAt; // the earliest sighting is what counts
      return false;
    }
    this.records.set(h, { item, f, seenAt });
    return true;
  }

  keyRecords(id) { return [...this.records.values()].filter((r) => r.f.kind === KIND.KEY && r.f.pub && hex(keyIdOf(spkiOf(r.f.pub))) === id); }
  revocations(id) { return [...this.records.values()].filter((r) => r.f.kind === KIND.REVOKE && hex(r.f.target) === id); }
  pubOf(id) {
    if (this.anchors.has(id)) return this.anchors.get(id).pub;
    const r = this.keyRecords(id)[0];
    return r ? spkiOf(r.f.pub) : null;
  }

  // The chain of a key id up to an anchor: { ok, rec, anchor, chain: [ids] } or { ok:false, reason }.
  // Checks signatures, the issue role at issuance, and issuer revocation (seen-before rule).
  chainOf(id, depth = 0) {
    if (this.anchors.has(id)) return { ok: true, anchor: id, chain: [id], roles: ROLE.CUSTODY | ROLE.ISSUE | ROLE.REVOKE, anchorRec: this.anchors.get(id) };
    if (depth >= MAX_DEPTH) return { ok: false, reason: "chain_too_long" };
    const recs = this.keyRecords(id);
    if (!recs.length) return { ok: false, reason: depth ? "chain_not_anchored" : "key_unknown" };
    let last = { ok: false, reason: "issuer_unknown" };
    for (const r of recs) {
      const issuerId = hex(r.f.issuer);
      const up = this.chainOf(issuerId, depth + 1);
      if (!up.ok) { last = up; continue; }
      if (!(up.roles & ROLE.ISSUE)) { last = { ok: false, reason: "issuer_lacks_issue_role" }; continue; }
      if (!verify1(r.item, this.pubOf(issuerId)).ok) { last = { ok: false, reason: "record_signature_invalid" }; continue; }
      if (up.rec && !this.inWindow(up.rec.f, r.f.issuedAt)) { last = { ok: false, reason: "issuer_not_valid_at_issuance" }; continue; }
      const T = this.revokedFrom(issuerId, depth + 1);
      if (T !== null && !(r.seenAt < T)) { last = { ok: false, reason: "issuer_revoked" }; continue; }
      return { ok: true, rec: r, anchor: up.anchor, chain: [id, ...up.chain], roles: r.f.roles };
    }
    return last;
  }

  inWindow(f, t) { return t >= f.notBefore - this.skewMs && t <= f.notAfter + this.skewMs; }

  // Earliest effectiveFrom among authorized revocations of id, or null.
  revokedFrom(id, depth = 0) {
    if (depth >= MAX_DEPTH) return null;
    let T = null;
    const target = this.chainOf(id, depth + 1);
    const targetPub = this.pubOf(id);
    for (const r of this.revocations(id)) {
      const signerId = hex(r.f.issuer);
      const signerPub = this.pubOf(signerId);
      if (!signerPub || !verify1(r.item, signerPub).ok) continue;
      let allowed = false;
      if (signerId === id) allowed = !!targetPub;                                    // self-revocation
      else if (target.ok && target.chain.includes(signerId)) allowed = true;          // its issuing chain
      else if (this.anchors.has(signerId)) allowed = true;                            // an anchor
      else {
        const s = this.chainOf(signerId, depth + 1);                                  // a revoke-role key, same anchor
        allowed = s.ok && !!(s.roles & ROLE.REVOKE) && target.ok && s.anchor === target.anchor;
      }
      if (allowed && (T === null || r.f.effectiveFrom < T)) T = r.f.effectiveFrom;
    }
    return T;
  }

  // Candidate public keys for an EID (anchors that name it, and keys issued to it).
  pubsFor(eid) {
    const out = [];
    for (const a of this.anchors.values()) if (a.eid === eid) out.push(a.pub);
    for (const r of this.records.values()) if (r.f.kind === KIND.KEY && r.f.subject === eid && r.f.pub) out.push(spkiOf(r.f.pub));
    return [...new Set(out)];
  }

  // May `pub` sign custody for `eid` at time t? { ok, revokedFrom|null, anchor } or { ok:false, reason }.
  status(pub, eid, t, role = ROLE.CUSTODY) {
    const id = hex(keyIdOf(pub));
    const c = this.chainOf(id);
    if (!c.ok) return c;
    if (c.rec) {
      if (c.rec.f.subject !== eid) return { ok: false, reason: "key_not_for_this_node" };
      if (!(c.roles & role)) return { ok: false, reason: "key_lacks_role" };
      if (!this.inWindow(c.rec.f, t)) return { ok: false, reason: t < c.rec.f.notBefore ? "key_not_yet_valid" : "key_expired" };
    } else if (c.anchorRec.eid !== eid) return { ok: false, reason: "key_not_for_this_node" };
    return { ok: true, revokedFrom: this.revokedFrom(id), anchor: c.anchor, keyId: id };
  }

  // Records worth carrying onward: every revocation, then the key chains asked for.
  forCarriage(chainIds = []) {
    const out = [...this.records.values()].filter((r) => r.f.kind === KIND.REVOKE).map((r) => r.item);
    for (const id of chainIds) {
      const c = this.chainOf(id);
      if (!c.ok) continue;
      for (const k of c.chain) for (const r of this.keyRecords(k)) out.push(r.item);
    }
    return out;
  }
}

// ---- Key Record Block (type 225) -------------------------------------------------------
export function readKeyBlock(bundle) {
  const all = bundle.blocks.filter((x) => x.type === KEY_BLOCK_TYPE);
  if (all.length > 1) throw new Error("key record block malformed: more than one in the bundle");
  if (!all.length) return [];
  const items = decode(all[0].data);
  if (!Array.isArray(items) || !items.every((x) => Array.isArray(x) && x.length === 4)) throw new Error("key record block malformed");
  return items;
}

// Merge records into the bundle's block 225 (deduplicated, revocations first, capped).
// Custodians call this as they stamp, so revocations ride along with ordinary traffic.
export function carryRecords(bytes, records) {
  const bundle = decodeBundle(bytes);
  const seen = new Map();
  for (const it of [...readKeyBlock(bundle), ...records]) seen.set(recordHash(it), it);
  const all = [...seen.values()];
  const kindOf = (it) => { try { return recordFields(it).kind; } catch { return 0; } };
  all.sort((a, b) => (kindOf(b) === KIND.REVOKE) - (kindOf(a) === KIND.REVOKE));
  if (!all.length) return bytes;
  const kept = all.slice(0, MAX_BLOCK_RECORDS);
  return encodeBundle(putBlock(bundle, { type: KEY_BLOCK_TYPE, flags: BLOCK_FLAG.REPLICATE_IN_FRAGMENTS, crcType: CRC32C, data: encode(kept) }));
}

// Take every record a bundle carries into the keyring, as seen at local time `at`.
export function ingest(keyring, bytes, at) {
  let n = 0;
  for (const it of readKeyBlock(decodeBundle(bytes))) if (keyring.add(it, at)) n++;
  return n;
}
