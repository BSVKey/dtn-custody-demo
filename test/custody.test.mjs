import { test } from "node:test";
import assert from "node:assert/strict";
import { genKeypair } from "../agent/lib/keys.mjs";
import { makeRelay } from "../agent/relay.mjs";
import { verifyCustodyChain, verifyRecord } from "../agent/lib/receipt.mjs";

const A = "dtn://relaya/";
const B = "dtn://relayb/";
const SRC = "dtn://source/";

function chainFor() {
  const kpA = genKeypair(), kpB = genKeypair();
  const relayA = makeRelay(kpA, A), relayB = makeRelay(kpB, B);
  const bundle = { payloadId: "0xp", bundleId: "0xbundle1" };
  const r1 = relayA.stamp(bundle, SRC, 100, 150);
  const r2 = relayB.stamp(bundle, A, 500, 550);
  const hops = [{ eid: A, pub: kpA.pub }, { eid: B, pub: kpB.pub }];
  return { bundle, receipts: [r1, r2], hops, kpA, kpB };
}

test("a well-formed 2-hop custody chain verifies", () => {
  const { receipts, hops } = chainFor();
  assert.deepEqual(verifyCustodyChain(receipts, { bundleId: "0xbundle1", hops }), { ok: true, hops: 2 });
});

test("each receipt is individually authentic", () => {
  const { receipts } = chainFor();
  for (const r of receipts) assert.equal(verifyRecord(r).ok, true);
});

test("a forged signature is caught", () => {
  const { receipts, hops } = chainFor();
  const forged = [...receipts];
  forged[1] = { ...forged[1], sig: Buffer.from("nope").toString("base64") };
  const res = verifyCustodyChain(forged, { bundleId: "0xbundle1", hops });
  assert.equal(res.ok, false);
  assert.equal(res.reason, "signature_invalid");
});

test("a missing hop is caught (wrong count)", () => {
  const { receipts, hops } = chainFor();
  assert.equal(verifyCustodyChain([receipts[0]], { bundleId: "0xbundle1", hops }).reason, "wrong_hop_count");
});

test("a signer that is not the pinned hop key is caught", () => {
  const { receipts, hops } = chainFor();
  const wrong = [{ ...hops[0], pub: genKeypair().pub }, hops[1]];
  assert.equal(verifyCustodyChain(receipts, { bundleId: "0xbundle1", hops: wrong }).reason, "signer_not_pinned_hop_key");
});

test("a broken prevHop link is caught", () => {
  const kpA = genKeypair(), kpB = genKeypair();
  const relayA = makeRelay(kpA, A), relayB = makeRelay(kpB, B);
  const bundle = { payloadId: "0xp", bundleId: "0xbundle1" };
  const r1 = relayA.stamp(bundle, SRC, 100, 150);
  const r2 = relayB.stamp(bundle, "dtn://someone-else/", 500, 550); // wrong prevHop
  const hops = [{ eid: A, pub: kpA.pub }, { eid: B, pub: kpB.pub }];
  assert.equal(verifyCustodyChain([r1, r2], { bundleId: "0xbundle1", hops }).reason, "custody_chain_break");
});
