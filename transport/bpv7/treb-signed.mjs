// Signed hop-records for the Traceroute Extension Block (TREB, draft-koo-dtn-traceroute-eb-02).
//
// A TREB hop-record is unauthenticated by design: the draft's own security section says
// hop-records "SHALL be treated as diagnostic data only" and that "an on-path node can forge
// records that are consistent with one another". This module is a proposed optional profile that
// closes that gap without changing the hop-record itself:
//
//   signed-hop-record = [ ...the 7 TREB hop-record fields unchanged..., hop-signature ]
//   hop-signature     = COSE_Sign1 with a DETACHED payload (nil): the payload is the CBOR
//                       encoding of the first 7 fields, which the verifier already holds;
//                       external_aad = CBOR [bundle identity, SHA-256 of the payload block's data]
//
// A reader that ignores the eighth element sees an ordinary TREB hop-record. A verifier with the
// recording node's key gets what a custody receipt gives (custody-receipt-block, receipt-v2.mjs):
// the node is bound to this exact bundle and the payload bytes it held. Proposal only; TREB's
// CDDL fixes the hop-record at 7 fields today.
import { encode, decode } from "./cbor.mjs";
import { encodeEid, decodeEid } from "./bundle.mjs";
import { sign1, verify1 } from "./cose.mjs";
import { bundleIdentity, payloadHash } from "./receipt-v2.mjs";

// TREB section 3.2 hop-record, as a JS array ready to CBOR-encode.
export function hopRecord({ self, prev = "dtn:none", next, eventType = 0, eventTime = 0, radiateTime = 0,
  link = { type: 0, speed: 0, distance: 0, cl: 0, congestion: 0 } }) {
  return [encodeEid(self), encodeEid(prev), encodeEid(next), eventType, eventTime, radiateTime,
    [link.type, link.speed, link.distance, link.cl, link.congestion]];
}
export function readHopRecord(r) {
  return { self: decodeEid(r[0]), prev: decodeEid(r[1]), next: decodeEid(r[2]), eventType: r[3], eventTime: r[4],
    radiateTime: r[5], link: { type: r[6][0], speed: r[6][1], distance: r[6][2], cl: r[6][3], congestion: r[6][4] },
    signed: r.length === 8 };
}

const aadFor = (bundle) => encode([bundleIdentity(bundle), payloadHash(bundle)]);

// Append a detached signature to a 7-field hop-record, binding it to `bundle` (decoded).
export function signHopRecord(priv, record, bundle) {
  if (record.length !== 7) throw new Error("expected an unsigned 7-field TREB hop-record");
  return [...record, sign1(priv, encode(record), { aad: aadFor(bundle), detached: true })];
}

// Verify one hop-record. Unsigned records are reported as such (diagnostic only, as TREB says).
export function verifyHopRecord(record, pubB64, bundle) {
  if (record.length === 7) return { ok: false, reason: "unsigned" };
  if (record.length !== 8) return { ok: false, reason: "not_a_hop_record" };
  // Work on the wire form, as a receiver would: encode, then decode, the record.
  const wire = decode(encode(record));
  return verify1(wire[7], pubB64, { aad: aadFor(bundle), payload: encode(wire.slice(0, 7)) });
}

// A whole recorded path: which records are signed and valid under the verifier's pinned keys
// (by self-node-id), and where adjacent records fail to chain (TREB section 4.8.3: at least one
// transparent node lies between them).
export function auditHopRecords(records, keys, bundle) {
  const out = { signed: 0, unsigned: 0, failed: [], gaps: [] };
  let prev = null;
  records.forEach((r, i) => {
    const h = readHopRecord(r);
    if (!h.signed) out.unsigned++;
    else {
      const v = verifyHopRecord(r, keys[h.self], bundle);
      if (v.ok) out.signed++; else out.failed.push({ index: i, node: h.self, reason: v.reason });
    }
    if (prev && (prev.next !== h.self || (h.prev !== "dtn:none" && h.prev !== prev.self))) {
      out.gaps.push({ after: prev.self, before: h.self, expectedNext: prev.next, observedPrev: h.prev });
    }
    prev = h;
  });
  out.ok = out.failed.length === 0;
  return out;
}

export const decodeHopRecords = (bytes) => decode(bytes);
