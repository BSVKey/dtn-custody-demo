// End-to-end acceptance criteria (1-5 of the build plan; #6's live anchor is out of
// scope for offline CI). One deterministic run through the simulated DTN with an
// occultation window, asserting the whole application layer holds together.
import { test } from "node:test";
import assert from "node:assert/strict";
import { genKeypair } from "../agent/lib/keys.mjs";
import { prepare } from "../agent/source.mjs";
import { makeRelay } from "../agent/relay.mjs";
import { makeDest } from "../agent/dest.mjs";
import { gapObject } from "../agent/lib/gap.mjs";
import { simulate, defaultSimPlan } from "../transport/sim.mjs";

const EID = { src: "dtn://source/", a: "dtn://relaya/", b: "dtn://relayb/", dst: "dtn://dest/" };

function runOnce() {
  const source = genKeypair(), kpA = genKeypair(), kpB = genKeypair(), destKp = genKeypair();
  const payload = Buffer.from("payload ".repeat(200), "utf8"); // ~1.6 KB
  const { manifest, bundles } = prepare(source, payload, { payloadId: "0xframe", chunkSize: 64 });
  const relays = { [EID.a]: makeRelay(kpA, EID.a), [EID.b]: makeRelay(kpB, EID.b) };
  const sim = simulate({ plan: defaultSimPlan, bundles, relays });
  const pinnedHops = [{ eid: EID.a, pub: kpA.pub }, { eid: EID.b, pub: kpB.pub }];
  const dest = makeDest(destKp, manifest, pinnedHops, { sourcePub: source.pub });
  for (const bundle of sim.arrivalOrder) {
    const r = dest.receiveBundle(bundle);
    assert.equal(r.ok, true, `chunk ${bundle.index} should verify`);
    for (const rec of sim.custodyByBundle.get(bundle.bundleId)) dest.recordCustody(bundle.bundleId, rec);
  }
  return { source, kpA, kpB, destKp, payload, manifest, bundles, sim, dest, pinnedHops };
}

test("criterion 1: chunks arrive OUT OF ORDER and each verifies against the root", () => {
  const { sim, bundles } = runOnce();
  const order = sim.arrivalOrder.map((b) => b.index);
  assert.equal(order.length, bundles.length);
  assert.ok(order.some((v, i) => v !== i), "arrival order should differ from send order");
});

test("criterion 1b: a tampered chunk is rejected", () => {
  const { sim, dest } = runOnce();
  const b = { ...sim.arrivalOrder[0] };
  const bytes = Buffer.from(b.bytesB64, "base64"); bytes[0] ^= 0xff; b.bytesB64 = bytes.toString("base64");
  assert.equal(dest.receiveBundle(b).ok, false);
});

test("criterion 1c: the payload reassembles exactly", () => {
  const { dest, payload } = runOnce();
  assert.equal(dest.isComplete(), true);
  assert.ok(dest.reassemble().equals(payload));
});

test("criterion 2: every bundle's custody chain verifies across both hops", () => {
  const { dest, bundles } = runOnce();
  for (const b of bundles) {
    const c = dest.verifyChain(b.bundleId);
    assert.equal(c.ok, true, `bundle ${b.index}: ${c.reason || ""}`);
  }
});

test("criterion 3: the occultation produces a gap object with a nonempty delayed set", () => {
  const { sim } = runOnce();
  assert.ok(sim.delayed.length > 0, "the blackout should delay some bundles");
  const g = gapObject({ link: sim.occultedLink, linkEvents: sim.linkEvents, delayed: sim.delayed, lost: sim.lost });
  assert.equal(g.downAt, defaultSimPlan.occultation.downMs);
  assert.equal(g.upAt, defaultSimPlan.occultation.upMs);
  assert.equal(g.bundlesDelayed.length, sim.delayed.length);
});

test("criterion 4: delivery binds to the settlement the verifier paid, refuses otherwise", () => {
  const { dest, destKp, manifest } = runOnce();
  const settlementRef = "0x" + "4e40b7bf".repeat(8);
  const args = { payloadId: manifest.payloadId, root: manifest.root, rail: "bsv", network: "bsv",
    settlementRef, payTo: "1LdqUbdZ6GY71KxThU6aKfuKXxgmTn82cv", amountAtomic: 5942 };
  assert.equal(dest.settle(destKp, args, { settlementRef }).bind.ok, true);
  assert.equal(dest.settle(destKp, args, { settlementRef: "0x" + "9".repeat(64) }).bind.reason, "settlementRef_not_mine");
  assert.match(dest.settle(destKp, args, {}).bind.reason, /^unbound/);
});

test("criterion 5: the manifest root re-derives from the received payload", () => {
  const { dest, manifest, source, payload } = runOnce();
  // Re-preparing the reassembled bytes with the same chunking yields the same root.
  const re = prepare(source, dest.reassemble(), { payloadId: manifest.payloadId, chunkSize: 64 });
  assert.equal(re.manifest.root, manifest.root);
});

test("criterion 1d: authorship is pinned: a stranger-signed manifest is refused, an unpinned dest refuses", () => {
  // Reported by Sunnie: the manifest verified under the signerPub it carried, so a
  // payload prepared by a key the destination had never seen verified end to end.
  const source = genKeypair(), stranger = genKeypair(), destKp = genKeypair();
  const hops = [{ eid: EID.a, pub: genKeypair().pub }, { eid: EID.b, pub: genKeypair().pub }];
  const forged = prepare(stranger, Buffer.from("forgery ".repeat(200)), { payloadId: "0xframe", chunkSize: 64 }).manifest;
  assert.throws(() => makeDest(destKp, forged, hops, { sourcePub: source.pub }), (e) => e.reason === "signer_not_pinned_source_key");
  const real = prepare(source, Buffer.from("payload ".repeat(200)), { payloadId: "0xframe", chunkSize: 64 }).manifest;
  assert.throws(() => makeDest(destKp, real, hops), (e) => e.reason === "unpinned");
  assert.throws(() => makeDest(destKp, real, hops, {}), (e) => e.reason === "unpinned");
  // Swapping in the stranger's key as signerPub breaks the signature, not the pin.
  assert.throws(() => makeDest(destKp, { ...real, signerPub: stranger.pub }, hops, { sourcePub: stranger.pub }));
  assert.doesNotThrow(() => makeDest(destKp, real, hops, { sourcePub: source.pub }));
});

test("criterion 1e: pins compare exactly: a case-flipped copy of a real key or address is refused", () => {
  // Reported by Sunnie: the source-key compare lowercased both sides, but base64
  // keys (and Base58 addresses) are case-sensitive, so a case-flipped copy of the
  // rover's key was accepted as the pin.
  const source = genKeypair(), destKp = genKeypair();
  const hops = [{ eid: EID.a, pub: genKeypair().pub }, { eid: EID.b, pub: genKeypair().pub }];
  const manifest = prepare(source, Buffer.from("payload ".repeat(200)), { payloadId: "0xframe", chunkSize: 64 }).manifest;
  const flip = (s) => [...s].map((c) => (c === c.toLowerCase() ? c.toUpperCase() : c.toLowerCase())).join("");
  assert.notEqual(flip(source.pub), source.pub, "the key has letters to flip");
  assert.throws(() => makeDest(destKp, manifest, hops, { sourcePub: flip(source.pub) }), (e) => e.reason === "signer_not_pinned_source_key");
  assert.doesNotThrow(() => makeDest(destKp, manifest, hops, { sourcePub: source.pub }));

  const { dest } = runOnce();
  const settlementRef = "0x" + "4e40b7bf".repeat(8), payTo = "1LdqUbdZ6GY71KxThU6aKfuKXxgmTn82cv";
  const args = { payloadId: "0xframe", root: manifest.root, rail: "bsv", network: "bsv", settlementRef, payTo, amountAtomic: 5942 };
  assert.equal(dest.settle(destKp, args, { settlementRef, payTo: flip(payTo) }).bind.reason, "payTo_mismatch");
  assert.equal(dest.settle(destKp, args, { settlementRef: settlementRef.toUpperCase().replace("0X", "0x"), payTo }).bind.ok, true, "a hex txid still matches in any case");
});
