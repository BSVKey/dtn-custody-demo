import { test } from "node:test";
import assert from "node:assert/strict";
import { encode, decode } from "../transport/bpv7/cbor.mjs";
import { encodeBundle, decodeBundle, encodeEid, BLOCK, BUNDLE_FLAG, CRC16, CRC32C } from "../transport/bpv7/bundle.mjs";
import { stampBundleV2, verifyBundleV2, readBlockItems, receiptFields, MAX_RECEIPTS } from "../transport/bpv7/receipt-v2.mjs";
import { stampBundle, CUSTODY_BLOCK_TYPE } from "../transport/bpv7/custody-block.mjs";
import { addBib, verifyBibs } from "../transport/bpv7/bpsec.mjs";
import { genKeypair } from "../agent/lib/keys.mjs";
import { makeRelay } from "../agent/relay.mjs";
import { prepare } from "../agent/source.mjs";

// An opaque payload: version 2 never parses it.
const OPAQUE = Buffer.from(Array.from({ length: 1200 }, (_, i) => (i * 37) & 0xff));
function bundle({ payload = OPAQUE, created = [5000, 7], fragment, previousNode } = {}) {
  const primary = { crcType: CRC32C, dest: "ipn:2.1", source: "ipn:5.1", created, lifetime: 3600000 };
  if (fragment) Object.assign(primary, { flags: BUNDLE_FLAG.IS_FRAGMENT, fragmentOffset: fragment[0], totalAduLength: fragment[1] });
  const blocks = [];
  if (previousNode) blocks.push({ type: BLOCK.PREVIOUS_NODE, number: 2, crcType: CRC16, data: encode(encodeEid(previousNode)) });
  blocks.push({ type: BLOCK.PAYLOAD, number: 1, crcType: CRC32C, data: payload });
  return encodeBundle({ primary, blocks });
}
function custodians(...eids) {
  const list = eids.map((eid) => ({ kp: genKeypair(), eid }));
  return { list, keys: Object.fromEntries(list.map((c) => [c.eid, c.kp.pub])) };
}
const chain = (bytes, cs, origin = "ipn:5.0") =>
  cs.reduce((acc, c, i) => stampBundleV2(acc, c, { prevHop: i ? cs[i - 1].eid : origin, receivedAt: 10 * i, forwardedAt: 10 * i + 5 }), bytes);

test("v2: two custodians sign COSE_Sign1 receipts over an opaque payload; the chain is complete", () => {
  const { list, keys } = custodians("ipn:20.0", "ipn:30.0");
  const b0 = bundle(), out = chain(b0, list);
  const v = verifyBundleV2(out, { keys, origin: "ipn:5.0", lastNode: "ipn:30.0" });
  assert.deepEqual(v, { ok: true, complete: true, custodied: 2, gaps: [], hashUnchecked: [], bundle: ["ipn:5.1", [5000, 7]] });
  assert.equal(readBlockItems(decodeBundle(out)).version, 2);
  const perReceipt = (out.length - b0.length) / 2;
  assert.ok(perReceipt < 200, `about ${perReceipt} bytes per receipt (version 1 is about 530)`);
  // Pinned-route mode, as in version 1.
  assert.equal(verifyBundleV2(out, { keys, hops: ["ipn:20.0", "ipn:30.0"], origin: "ipn:5.0", lastNode: "ipn:30.0" }).ok, true);
  assert.equal(verifyBundleV2(out, { keys, hops: ["ipn:30.0", "ipn:20.0"] }).reason, "unexpected_hop");
});

test("v2: the receipt binds the BPv7 bundle identity and the payload bytes held", () => {
  const { list, keys } = custodians("ipn:20.0", "ipn:30.0");
  const out = chain(bundle(), list);
  const f = receiptFields(readBlockItems(decodeBundle(out)).items[0]);
  assert.deepEqual(f.bundle, ["ipn:5.1", [5000, 7]]);
  assert.equal(f.payloadHash.length, 32);

  // Payload changed after the custodians held it.
  const b = decodeBundle(out);
  b.blocks.find((x) => x.type === BLOCK.PAYLOAD).data = Buffer.concat([OPAQUE, Buffer.from([0])]);
  assert.deepEqual(verifyBundleV2(encodeBundle(b), { keys }), { ok: false, reason: "payload_hash_mismatch", hop: 0 });

  // Receipts moved onto another bundle (different creation timestamp).
  const other = decodeBundle(bundle({ created: [5000, 8] }));
  other.blocks.unshift({ ...decodeBundle(out).blocks.find((x) => x.type === CUSTODY_BLOCK_TYPE), number: 9 });
  assert.equal(verifyBundleV2(encodeBundle(other), { keys }).reason, "wrong_bundle");
});

test("v2: an unpinned custodian, a wrong key and a forged signature are refused", () => {
  const { list, keys } = custodians("ipn:20.0", "ipn:30.0");
  const out = chain(bundle(), list);
  assert.deepEqual(verifyBundleV2(out, { keys: { "ipn:20.0": keys["ipn:20.0"] } }), { ok: false, reason: "custodian_not_pinned", hop: 1 });
  assert.equal(verifyBundleV2(out, { keys: { "ipn:20.0": keys["ipn:30.0"], "ipn:30.0": keys["ipn:30.0"] } }).reason, "signature_invalid");
  const b = decodeBundle(out);
  const blk = b.blocks.find((x) => x.type === CUSTODY_BLOCK_TYPE);
  const items = decode(blk.data);
  items[1][3] = Buffer.alloc(64, 1); // replace the signature
  blk.data = encode(items);
  assert.deepEqual(verifyBundleV2(encodeBundle(b), { keys }), { ok: false, reason: "signature_invalid", hop: 1 });
});

test("v2: a plain forwarder between custodians is an uncustodied gap; a missing receipt is reported, not inferred", () => {
  const { list, keys } = custodians("ipn:20.0", "ipn:30.0");
  const a = stampBundleV2(bundle(), list[0], { prevHop: "ipn:5.0", receivedAt: 1, forwardedAt: 2 });
  const c = stampBundleV2(a, list[1], { prevHop: "ipn:99.0", receivedAt: 3, forwardedAt: 4 });
  const v = verifyBundleV2(c, { keys, origin: "ipn:5.0", lastNode: "ipn:40.0" });
  assert.equal(v.complete, false);
  assert.deepEqual(v.gaps, [
    { afterHop: "ipn:20.0", beforeHop: "ipn:30.0", lastUnsigned: "ipn:99.0" },
    { afterHop: "ipn:30.0", beforeHop: null, lastUnsigned: "ipn:40.0" },
  ]);
  assert.equal(verifyBundleV2(c, { keys, hops: ["ipn:20.0", "ipn:30.0"] }).reason, "custody_chain_break");
  // The previous hop comes from the RFC 9171 Previous Node block when present.
  const viaPrev = stampBundleV2(bundle({ previousNode: "ipn:77.0" }), list[0], { receivedAt: 1, forwardedAt: 2 });
  assert.equal(receiptFields(readBlockItems(decodeBundle(viaPrev)).items[0]).prevHop, "ipn:77.0");
});

test("v2: fragments: a whole-bundle receipt still covers each fragment; a fragment receipt is hash-checked", () => {
  const { list, keys } = custodians("ipn:20.0", "ipn:30.0");
  const whole = stampBundleV2(bundle(), list[0], { prevHop: "ipn:5.0", receivedAt: 1, forwardedAt: 2 });
  // Fragment the bundle after hop 1: block 224 is replicated into every fragment.
  const w = decodeBundle(whole);
  const custody = w.blocks.find((x) => x.type === CUSTODY_BLOCK_TYPE);
  const frag = decodeBundle(bundle({ payload: OPAQUE.subarray(600), fragment: [600, OPAQUE.length] }));
  frag.blocks.unshift({ ...custody, number: 9 });
  const atC = stampBundleV2(encodeBundle(frag), list[1], { prevHop: "ipn:20.0", receivedAt: 3, forwardedAt: 4 });
  const v = verifyBundleV2(atC, { keys, origin: "ipn:5.0", lastNode: "ipn:30.0" });
  assert.equal(v.ok, true);
  assert.deepEqual(v.bundle, ["ipn:5.1", [5000, 7], 600, 1200]);
  assert.deepEqual(v.hashUnchecked, [0], "hop 1 signed the whole bundle; its hash is checkable only after reassembly");
  assert.deepEqual(receiptFields(readBlockItems(decodeBundle(atC)).items[1]).bundle, ["ipn:5.1", [5000, 7], 600, 1200]);
  // A receipt for a different fragment of the same bundle is refused.
  const other = decodeBundle(bundle({ payload: OPAQUE.subarray(0, 600), fragment: [0, OPAQUE.length] }));
  other.blocks.unshift({ ...decodeBundle(atC).blocks.find((x) => x.type === CUSTODY_BLOCK_TYPE), number: 9 });
  assert.deepEqual(verifyBundleV2(encodeBundle(other), { keys }), { ok: false, reason: "wrong_bundle", hop: 1 });
});

test("v2: one version per block, a bounded number of receipts, and version 1 untouched", () => {
  const { list } = custodians("ipn:20.0");
  // A block of version 1 receipts is not extended with version 2.
  const { bundles } = prepare(genKeypair(), Buffer.from("v1 ".repeat(800)), { chunkSize: 1024 });
  const c = bundles[0];
  const v1 = encodeBundle({
    primary: { crcType: CRC32C, dest: "ipn:2.1", source: "ipn:5.1", created: [1, 1], lifetime: 3600000 },
    blocks: [{ type: BLOCK.PAYLOAD, number: 1, crcType: CRC32C, data: Buffer.from(JSON.stringify({ payloadId: c.payloadId, index: c.index, leafHex: c.leafHex, bytesB64: c.bytesB64, branch: c.branch })) }],
  });
  const stamped1 = stampBundle(v1, makeRelay(genKeypair(), "dtn://a/"), { prevHop: "dtn://s/", receivedAt: 1, forwardedAt: 2 });
  assert.throws(() => stampBundleV2(stamped1, list[0], { prevHop: "x", receivedAt: 1, forwardedAt: 2 }), /one version/);
  assert.equal(verifyBundleV2(stamped1, { keys: {} }).reason, "not_version_2");
  // Mixed items in one block are malformed.
  const b = decodeBundle(stampBundleV2(bundle(), list[0], { prevHop: "ipn:5.0", receivedAt: 1, forwardedAt: 2 }));
  const blk = b.blocks.find((x) => x.type === CUSTODY_BLOCK_TYPE);
  blk.data = encode([...decode(blk.data), "{}"]);
  assert.equal(verifyBundleV2(encodeBundle(b), { keys: {} }).reason, "custody_block_malformed");
  assert.ok(MAX_RECEIPTS >= 16);
});

test("v2: a payload BIB still verifies after version 2 receipts are appended, and unaware nodes re-encode byte for byte", () => {
  const KEY = Buffer.from("1a2b1a2b1a2b1a2b1a2b1a2b1a2b1a2b", "hex");
  const signed = encodeBundle(addBib(decodeBundle(bundle()), { targets: [1], key: KEY, source: "ipn:5.1", scope: 7 }));
  const { list, keys } = custodians("ipn:20.0", "ipn:30.0");
  const out = chain(signed, list);
  assert.equal(verifyBibs(decodeBundle(out), KEY).ok, true);
  assert.equal(verifyBundleV2(out, { keys, origin: "ipn:5.0", lastNode: "ipn:30.0" }).complete, true);
  assert.ok(encodeBundle(decodeBundle(out)).equals(out));
});
