import { test } from "node:test";
import assert from "node:assert/strict";
import { encode, decode } from "../transport/bpv7/cbor.mjs";
import { encodeBundle, decodeBundle, BLOCK, CRC32C } from "../transport/bpv7/bundle.mjs";
import { hopRecord, readHopRecord, signHopRecord, verifyHopRecord, auditHopRecords } from "../transport/bpv7/treb-signed.mjs";
import { genKeypair } from "../agent/lib/keys.mjs";

const bundleOf = (payload, created = [7000, 3]) => decodeBundle(encodeBundle({
  primary: { crcType: CRC32C, dest: "ipn:2.1", source: "ipn:5.1", created, lifetime: 3600000 },
  blocks: [{ type: BLOCK.PAYLOAD, number: 1, crcType: CRC32C, data: Buffer.from(payload) }],
}));
const keysFor = (...eids) => {
  const list = eids.map((eid) => ({ eid, kp: genKeypair() }));
  return { list, keys: Object.fromEntries(list.map((x) => [x.eid, x.kp.pub])) };
};

test("treb-signed: the hop-record keeps TREB's 7-field shape; the signature is an optional 8th element", () => {
  const r = hopRecord({ self: "ipn:20.0", prev: "ipn:5.0", next: "ipn:30.0", eventType: 1, eventTime: 1000, link: { type: 2, speed: 2048, distance: 400, cl: 1, congestion: 10 } });
  assert.equal(r.length, 7);
  assert.deepEqual(decode(encode(r)), r, "round-trips as plain CBOR");
  const { list } = keysFor("ipn:20.0");
  const s = signHopRecord(list[0].kp.priv, r, bundleOf("data"));
  assert.equal(s.length, 8);
  assert.deepEqual(s.slice(0, 7), r, "the first 7 fields are unchanged, so a TREB reader still parses them");
  assert.equal(s[7][2], null, "detached payload: nothing duplicated on the wire");
  assert.equal(readHopRecord(s).self, "ipn:20.0");
});

test("treb-signed: a signed record verifies, and is bound to this bundle and these payload bytes", () => {
  const b = bundleOf("payload A");
  const { list, keys } = keysFor("ipn:20.0");
  const s = signHopRecord(list[0].kp.priv, hopRecord({ self: "ipn:20.0", prev: "ipn:5.0", next: "ipn:30.0", eventTime: 5 }), b);
  assert.equal(verifyHopRecord(s, keys["ipn:20.0"], b).ok, true);
  assert.equal(verifyHopRecord(s, keys["ipn:20.0"], bundleOf("payload B")).reason, "signature_invalid", "other payload");
  assert.equal(verifyHopRecord(s, keys["ipn:20.0"], bundleOf("payload A", [7000, 4])).reason, "signature_invalid", "other bundle");
  const forged = [...s]; forged[2] = hopRecord({ self: "ipn:20.0", next: "ipn:99.0" })[2];
  assert.equal(verifyHopRecord(forged, keys["ipn:20.0"], b).reason, "signature_invalid", "next hop changed");
  assert.equal(verifyHopRecord(s, genKeypair().pub, b).reason, "signature_invalid", "wrong key");
});

test("treb-signed: an audited path counts signed and unsigned records and finds TREB-style gaps", () => {
  const b = bundleOf("path");
  const { list, keys } = keysFor("ipn:20.0", "ipn:40.0");
  const r1 = signHopRecord(list[0].kp.priv, hopRecord({ self: "ipn:20.0", prev: "ipn:5.0", next: "ipn:30.0" }), b);
  const r2 = hopRecord({ self: "ipn:30.0", prev: "ipn:20.0", next: "ipn:35.0" }); // a TREB node that does not sign
  const r3 = signHopRecord(list[1].kp.priv, hopRecord({ self: "ipn:40.0", prev: "ipn:36.0", next: "ipn:2.0" }), b); // transparent node(s) before it
  const a = auditHopRecords([r1, r2, r3], keys, b);
  assert.equal(a.ok, true);
  assert.equal(a.signed, 2);
  assert.equal(a.unsigned, 1);
  assert.deepEqual(a.gaps, [{ after: "ipn:30.0", before: "ipn:40.0", expectedNext: "ipn:35.0", observedPrev: "ipn:36.0" }]);
  const tampered = [...r3]; tampered[4] = 99;
  assert.deepEqual(auditHopRecords([r1, r2, tampered], keys, b).failed, [{ index: 2, node: "ipn:40.0", reason: "signature_invalid" }]);
});
