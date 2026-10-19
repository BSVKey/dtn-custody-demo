import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { encode, bstr } from "../transport/bpv7/cbor.mjs";
import { encodeBundle, encodeEid, crc32c, crc32cUpdate, BLOCK, BUNDLE_FLAG, CRC_NONE, CRC16, CRC32C } from "../transport/bpv7/bundle.mjs";
import { stampBundleV2, verifyBundleV2 } from "../transport/bpv7/receipt-v2.mjs";
import { stampBundle } from "../transport/bpv7/custody-block.mjs";
import { toBeSigned, sign1, sign1Encoded } from "../transport/bpv7/cose.mjs";
import { BundleReceiver, receiveBundle, stampReceived, stampReceivedParts } from "../transport/bpv7/fast-stamp.mjs";
import { genKeypair } from "../agent/lib/keys.mjs";
import { makeRelay } from "../agent/relay.mjs";
import { prepare } from "../agent/source.mjs";

const PAYLOAD = Buffer.from(Array.from({ length: 5000 }, (_, i) => (i * 37) & 0xff));
function bundle({ payload = PAYLOAD, fragment, previousNode, payloadCrc = CRC32C, primaryCrc = CRC32C, extra = [] } = {}) {
  const primary = { crcType: primaryCrc, dest: "ipn:2.1", source: "ipn:5.1", created: [812345678901, 7], lifetime: 3600000 };
  if (fragment) Object.assign(primary, { flags: BUNDLE_FLAG.IS_FRAGMENT, fragmentOffset: fragment[0], totalAduLength: fragment[1] });
  const blocks = [...extra];
  if (previousNode) blocks.push({ type: BLOCK.PREVIOUS_NODE, number: 2, crcType: CRC16, data: encode(encodeEid(previousNode)) });
  blocks.push({ type: BLOCK.PAYLOAD, number: 1, crcType: payloadCrc, data: payload });
  return encodeBundle({ primary, blocks });
}
const relay = (eid) => ({ kp: genKeypair(), eid });
const A = relay("ipn:20.0"), B = relay("ipn:30.0");
const keys = { [A.eid]: A.kp.pub, [B.eid]: B.kp.pub };
const opts = (prevHop, i = 0) => ({ prevHop, receivedAt: 10 * i + 1, forwardedAt: 10 * i + 2 });

test("fast path: incremental hashing gives the payload SHA-256 for any chunking", () => {
  const b0 = bundle();
  const want = createHash("sha256").update(PAYLOAD).digest();
  for (const chunk of [1, 7, 64, 1472, 4096, b0.length]) {
    const rx = receiveBundle(b0, chunk);
    assert.deepEqual(rx.payloadHash, want, `chunk ${chunk}`);
    assert.deepEqual(rx.bytes, b0);
  }
});

test("fast path: output is byte-identical to stampBundleV2 (first custodian, chain, Previous Node, fragment, CRC types, subject)", () => {
  const cases = [
    ["plain", bundle(), opts("ipn:5.0")],
    ["previous node block", bundle({ previousNode: "ipn:5.0" }), { receivedAt: 1, forwardedAt: 2 }],
    ["fragment", bundle({ fragment: [1000, 90000] }), opts("ipn:5.0")],
    ["CRC-16 payload, no primary CRC", bundle({ payloadCrc: CRC16, primaryCrc: CRC_NONE }), opts("ipn:5.0")],
    ["no payload CRC", bundle({ payloadCrc: CRC_NONE }), opts("ipn:5.0")],
    ["subject", bundle(), { ...opts("ipn:5.0"), subject: "0xabc" }],
    ["other extension block kept", bundle({ extra: [{ type: BLOCK.HOP_COUNT, number: 3, crcType: CRC16, data: encode([30, 1]) }] }), opts("ipn:5.0")],
    ["empty payload", bundle({ payload: Buffer.alloc(0) }), opts("ipn:5.0")],
    ["1 MiB payload", bundle({ payload: Buffer.alloc(1 << 20, 3) }), opts("ipn:5.0")],
  ];
  for (const [name, b0, o] of cases) {
    const slow = stampBundleV2(b0, A, o);
    const fast = stampReceived(receiveBundle(b0, 1472), A, o);
    assert.deepEqual(fast, slow, name);
    // and a second custodian on top of the first
    const slow2 = stampBundleV2(slow, B, opts(A.eid, 1));
    const fast2 = stampReceived(receiveBundle(fast, 333), B, opts(A.eid, 1));
    assert.deepEqual(fast2, slow2, name + ", second custodian");
    assert.equal(verifyBundleV2(fast2, { keys, origin: o.prevHop ?? "ipn:5.0", lastNode: B.eid }).complete, true, name);
  }
});

test("fast path: the parts are a gathering write of the same bytes, with the payload not copied", () => {
  const b0 = bundle();
  const rx = receiveBundle(b0);
  const parts = stampReceivedParts(rx, A, opts("ipn:5.0"));
  assert.deepEqual(Buffer.concat(parts), stampBundleV2(b0, A, opts("ipn:5.0")));
  assert.equal(parts[2].buffer, rx.bytes.buffer, "payload part is a view of the received buffer");
});

test("fast path: a block full of 23, 24 and 63 receipts gets the right array head, and 64 is refused", () => {
  let b = bundle();
  const relays = Array.from({ length: 64 }, (_, i) => relay(`ipn:${100 + i}.0`));
  let prev = "ipn:5.0";
  for (let i = 0; i < 64; i++) {
    const slow = stampBundleV2(b, relays[i], opts(prev, i));
    const fast = stampReceived(receiveBundle(b, 4096), relays[i], opts(prev, i));
    assert.deepEqual(fast, slow, `receipt ${i + 1}`);
    b = fast; prev = relays[i].eid;
  }
  assert.throws(() => stampReceived(receiveBundle(b), A, opts(prev)), /custody block full/);
});

test("fast path: refuses what stampBundleV2 refuses, and rejects corrupt or incomplete bundles", () => {
  const c = prepare(genKeypair(), Buffer.from("v1 ".repeat(800)), { chunkSize: 1024 }).bundles[0];
  const chunk = Buffer.from(JSON.stringify({ payloadId: c.payloadId, index: c.index, leafHex: c.leafHex, bytesB64: c.bytesB64, branch: c.branch }));
  const v1 = stampBundle(bundle({ payload: chunk }), makeRelay(genKeypair(), "dtn://a/"), { prevHop: "dtn://s/", receivedAt: 1, forwardedAt: 2 });
  assert.throws(() => stampReceived(receiveBundle(v1), A, opts("ipn:5.0")), /version 1/);
  assert.throws(() => stampReceived(receiveBundle(bundle()), A, { receivedAt: 1, forwardedAt: 2 }), /previous hop unknown/);
  const b0 = bundle();
  const flipped = Buffer.from(b0); flipped[b0.length - 100] ^= 1;
  assert.throws(() => receiveBundle(flipped), /CRC mismatch/);
  const rx = new BundleReceiver(); rx.push(b0.subarray(0, b0.length - 1));
  assert.throws(() => rx.finish(), /truncated/);
  assert.throws(() => receiveBundle(Buffer.concat([b0, Buffer.from([0])])), /trailing bytes/);
  const badPrimary = Buffer.from(b0); badPrimary[5] ^= 1;
  assert.throws(() => receiveBundle(badPrimary));
});

test("COSE: the precomputed Sig_structure prefix and the direct encoder give the generic encoder's bytes", () => {
  const prot = encode(new Map([[1, -8]]));
  for (const len of [0, 1, 23, 24, 96, 255, 256, 70000]) {
    const p = Buffer.alloc(len, 5);
    assert.deepEqual(toBeSigned(prot, p), encode(["Signature1", bstr(prot), bstr(Buffer.alloc(0)), bstr(p)]));
    const kp = genKeypair();
    assert.deepEqual(sign1Encoded(kp.priv, p), encode(sign1(kp.priv, p)));
  }
  assert.deepEqual(toBeSigned(prot, Buffer.from([1]), Buffer.from([9])), encode(["Signature1", bstr(prot), bstr(Buffer.from([9])), bstr(Buffer.from([1]))]));
});

test("CRC-32C: incremental update over any split equals one pass", () => {
  const b = Buffer.from(Array.from({ length: 1000 }, (_, i) => (i * 13) & 0xff));
  for (const cut of [0, 1, 500, 999, 1000]) {
    const c = crc32cUpdate(crc32cUpdate(0xffffffff, b, 0, cut), b, cut, b.length);
    assert.equal((c ^ 0xffffffff) >>> 0, crc32c(b));
  }
});
