import { test } from "node:test";
import assert from "node:assert/strict";
import { encode, decode } from "../transport/bpv7/cbor.mjs";
import {
  crc16x25, crc32c, encodeBundle, decodeBundle, encodeEid, BLOCK, CRC16, CRC32C,
} from "../transport/bpv7/bundle.mjs";
import {
  stampBundle, verifyBundleCustody, readCustody, CUSTODY_BLOCK_TYPE,
} from "../transport/bpv7/custody-block.mjs";
import { genKeypair } from "../agent/lib/keys.mjs";
import { makeRelay } from "../agent/relay.mjs";
import { prepare } from "../agent/source.mjs";

test("bpv7: CRC-16/X-25 and CRC-32C match their published check values", () => {
  const check = Buffer.from("123456789");
  assert.equal(crc16x25(check), 0x906e);
  assert.equal(crc32c(check), 0xe3069283);
});

test("bpv7: CBOR heads are shortest-form and round-trip", () => {
  for (const v of [0, 23, 24, 255, 256, 65535, 65536, 2 ** 32, -1, -25, "dtn", ["a", [1, 2]], true, null]) {
    assert.deepEqual(decode(encode(v)), v);
  }
  assert.equal(encode(24).toString("hex"), "1818");
  assert.equal(encode(500).toString("hex"), "1901f4");
});

function chunkBundle(previousNode, fill = "x") {
  const { bundles } = prepare(genKeypair(), Buffer.from(fill.repeat(3000)), { chunkSize: 1024 });
  const c = bundles[1];
  const blocks = [];
  if (previousNode) blocks.push({ type: BLOCK.PREVIOUS_NODE, number: 2, crcType: CRC16, data: encode(encodeEid(previousNode)) });
  blocks.push({
    type: BLOCK.PAYLOAD, number: 1, crcType: CRC32C,
    data: Buffer.from(JSON.stringify({ payloadId: c.payloadId, index: c.index, leafHex: c.leafHex, bytesB64: c.bytesB64, branch: c.branch })),
  });
  const bytes = encodeBundle({
    primary: { crcType: CRC32C, dest: "dtn://dest/payload", source: "dtn://source/payload", created: [0, 1], lifetime: 3600000 },
    blocks,
  });
  return { bytes, bundleId: c.bundleId };
}

function twoHops() {
  const kpA = genKeypair(), kpB = genKeypair();
  return {
    relayA: makeRelay(kpA, "dtn://relaya/"), relayB: makeRelay(kpB, "dtn://relayb/"),
    hops: [{ eid: "dtn://relaya/", pub: kpA.pub }, { eid: "dtn://relayb/", pub: kpB.pub }],
  };
}

test("bpv7: custody receipts ride inside the bundle across two hops and verify at the destination", () => {
  const { bytes, bundleId } = chunkBundle();
  const { relayA, relayB, hops } = twoHops();
  const atA = stampBundle(bytes, relayA, { prevHop: "dtn://source/", receivedAt: 100, forwardedAt: 150 });
  const atB = stampBundle(atA, relayB, { prevHop: "dtn://relaya/", receivedAt: 500, forwardedAt: 550 });
  const v = verifyBundleCustody(atB, { hops });
  assert.deepEqual(v, { ok: true, hops: 2, bundleId });
  const b = decodeBundle(atB);
  assert.equal(b.blocks.filter((x) => x.type === CUSTODY_BLOCK_TYPE).length, 1, "one block, appended to");
  assert.equal(b.blocks.at(-1).type, BLOCK.PAYLOAD, "payload stays last");
  assert.equal(readCustody(b).length, 2);
});

test("bpv7: the previous hop is taken from the RFC 9171 Previous Node block when present", () => {
  const { bytes } = chunkBundle("dtn://source/");
  const { relayA } = twoHops();
  const out = decodeBundle(stampBundle(bytes, relayA, { receivedAt: 1, forwardedAt: 2 }));
  assert.equal(readCustody(out)[0].prevHop, "dtn://source/");
  assert.throws(() => stampBundle(chunkBundle().bytes, relayA, { receivedAt: 1, forwardedAt: 2 }), /previous hop unknown/);
});

test("bpv7: an unaware node that forwards the bundle unchanged keeps the chain valid", () => {
  const { bytes } = chunkBundle();
  const { relayA, relayB, hops } = twoHops();
  const atA = stampBundle(bytes, relayA, { prevHop: "dtn://source/", receivedAt: 1, forwardedAt: 2 });
  // A plain BPv7 node decodes and re-encodes every block it does not understand as is.
  const passedThrough = encodeBundle(decodeBundle(atA));
  assert.ok(passedThrough.equals(atA), "re-encoding is byte-identical");
  const atB = stampBundle(passedThrough, relayB, { prevHop: "dtn://relaya/", receivedAt: 3, forwardedAt: 4 });
  assert.equal(verifyBundleCustody(atB, { hops }).ok, true);
});

test("bpv7: tampering is refused with a reason", () => {
  const { bytes } = chunkBundle();
  const { relayA, relayB, hops } = twoHops();
  const atA = stampBundle(bytes, relayA, { prevHop: "dtn://source/", receivedAt: 1, forwardedAt: 2 });
  const atB = stampBundle(atA, relayB, { prevHop: "dtn://relaya/", receivedAt: 3, forwardedAt: 4 });

  // A bit flip anywhere is caught by the block CRCs before any record is read.
  const flipped = Buffer.from(atB); flipped[Math.floor(flipped.length / 2)] ^= 0x01;
  assert.equal(verifyBundleCustody(flipped, { hops }).reason, "bundle_malformed");

  // Dropping a hop's receipt (and re-sealing CRCs) breaks the pinned chain.
  const b = decodeBundle(atB);
  const blk = b.blocks.find((x) => x.type === CUSTODY_BLOCK_TYPE);
  blk.data = encode(decode(blk.data).slice(1));
  assert.equal(verifyBundleCustody(encodeBundle(b), { hops }).reason, "wrong_hop_count");

  // Moving the receipts onto a different chunk is refused: the id comes from the payload.
  const other = decodeBundle(chunkBundle(null, "y").bytes);
  other.blocks.unshift({ ...decodeBundle(atB).blocks.find((x) => x.type === CUSTODY_BLOCK_TYPE), number: 5 });
  assert.equal(verifyBundleCustody(encodeBundle(other), { hops }).reason, "wrong_bundle");

  assert.equal(verifyBundleCustody(bytes, { hops }).reason, "no_custody_block");
});

test("bpv7: the custody block never asks a node to drop the bundle or the block", () => {
  const { bytes } = chunkBundle();
  const { relayA } = twoHops();
  const blk = decodeBundle(stampBundle(bytes, relayA, { prevHop: "dtn://source/", receivedAt: 1, forwardedAt: 2 }))
    .blocks.find((x) => x.type === CUSTODY_BLOCK_TYPE);
  assert.equal(blk.flags & 0x04, 0, "not: delete bundle if unprocessed");
  assert.equal(blk.flags & 0x10, 0, "not: discard block if unprocessed");
  assert.equal(blk.flags & 0x01, 1, "replicated into every fragment");
  assert.ok(blk.type >= 192 && blk.type <= 255, "private/experimental block type range");
});
