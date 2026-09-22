// End-to-end demo (make demo): chunk -> Merkle -> multi-hop store-and-forward with a
// scripted occultation -> out-of-order Merkle verification -> per-hop custody receipts
// -> gap object across the blackout -> delivery bound to a settlement. Fully offline.
//
// The one seam to production: `settlementRef` below is a placeholder. In the live
// path it is readSettlement(res).txid from a real BSV payment, and the demo's
// `--live` mode (TODO) anchors the manifest root on-chain.
import { genKeypair } from "./agent/lib/keys.mjs";
import { prepare } from "./agent/source.mjs";
import { makeRelay } from "./agent/relay.mjs";
import { makeDest } from "./agent/dest.mjs";
import { gapObject } from "./agent/lib/gap.mjs";
import { simulate, defaultSimPlan } from "./transport/sim.mjs";

const line = (s = "") => console.log(s);
const ok = (b) => (b ? "PASS" : "FAIL");

// Four node identities + a delivery signer (the destination signs delivery here).
const source = genKeypair();
const relayaKp = genKeypair();
const relaybKp = genKeypair();
const destKp = genKeypair();

const EID = { src: "dtn://source/", a: "dtn://relaya/", b: "dtn://relayb/", dst: "dtn://dest/" };

// A payload (stand-in for a rover image / short clip): ~1.2 KB over 64-byte chunks.
const payload = Buffer.from(
  "SPACE OCEAN DTN CUSTODY DEMO :: " +
    "verifiable data custody and relay-payment over a delay/disruption-tolerant link. " +
    "This payload is chunked, Merkle-committed, carried across three hops with a " +
    "scripted occultation, verified out of order against the manifest root, custody-" +
    "stamped at every relay, and delivered bound to a settlement. ".repeat(6),
  "utf8",
);

line("== Source: chunk + Merkle + signed manifest ==");
const { manifest, bundles } = prepare(source, payload, { payloadId: "0xrover-frame-001", chunkSize: 64 });
line(`  payloadId ${manifest.payloadId} | chunks ${manifest.chunkCount} | root ${manifest.root.slice(0, 18)}...`);

line("\n== Transport: 3 hops, reorder + occultation (compressed) ==");
const relays = { [EID.a]: makeRelay(relayaKp, EID.a), [EID.b]: makeRelay(relaybKp, EID.b) };
const sim = simulate({ plan: defaultSimPlan, bundles, relays });
line(`  occulted link ${sim.occultedLink} down@${defaultSimPlan.occultation.downMs}ms up@${defaultSimPlan.occultation.upMs}ms`);
line(`  bundles held by the blackout: ${sim.delayed.length} of ${bundles.length}`);
const inOrder = sim.arrivalOrder.map((b) => b.index);
line(`  arrival order (first 12): ${inOrder.slice(0, 12).join(", ")}${inOrder.length > 12 ? " ..." : ""}`);
line(`  out of order? ${ok(inOrder.some((v, i) => v !== i))}`);

line("\n== Destination: verify each chunk against the root, out of order ==");
const pinnedHops = [{ eid: EID.a, pub: relayaKp.pub }, { eid: EID.b, pub: relaybKp.pub }];
const dest = makeDest(destKp, manifest, pinnedHops);
let accepted = 0, rejected = 0;
for (const bundle of sim.arrivalOrder) {
  const r = dest.receiveBundle(bundle);
  if (r.ok) { accepted++; for (const rec of sim.custodyByBundle.get(bundle.bundleId)) dest.recordCustody(bundle.bundleId, rec); }
  else rejected++;
}
line(`  accepted ${accepted} | rejected ${rejected} | complete ${ok(dest.isComplete())}`);
const reassembled = dest.reassemble();
line(`  reassembled == original? ${ok(reassembled.equals(payload))}`);

line("\n== Tamper control: flip one byte in a chunk ==");
const victim = { ...sim.arrivalOrder[0] };
const bad = Buffer.from(victim.bytesB64, "base64"); bad[0] ^= 0xff; victim.bytesB64 = bad.toString("base64");
line(`  tampered chunk accepted? ${dest.receiveBundle(victim).ok ? "yes (BUG)" : "no -> rejected (PASS)"}`);

line("\n== Custody chain for one bundle ==");
const sample = sim.arrivalOrder[0].bundleId;
const chain = dest.verifyChain(sample);
line(`  chain verifies across ${pinnedHops.length} hops? ${ok(chain.ok)} ${chain.ok ? "" : "(" + chain.reason + ")"}`);
// forged-hop detection: tamper a copy of the recorded receipts and re-run the check.
import("./agent/lib/receipt.mjs").then(({ verifyCustodyChain }) => {
  const forged = dest._custody.get(sample).map((r, i) => (i === 1 ? { ...r, sig: "AAAA" } : r));
  const res = verifyCustodyChain(forged, { bundleId: sample, hops: pinnedHops });
  line(`  forged hop detected? ${ok(!res.ok)} ${res.ok ? "" : "(" + res.reason + ")"}`);
});

line("\n== Gap object across the occultation ==");
const gap = gapObject({ link: sim.occultedLink, linkEvents: sim.linkEvents, delayed: sim.delayed, lost: sim.lost });
line(`  ${gap.kind} link ${gap.link} down@${gap.downAt}ms up@${gap.upAt}ms duration ${gap.durationMs}ms delayed ${gap.bundlesDelayed.length} lost ${gap.bundlesLostConfirmed.length}`);

line("\n== Delivery bound to the settlement the verifier paid ==");
const settlementRef = "0x4e40b7bf86a0ca24f9746f3b6b5178def04b3a29024e4c7c9f8b95099ce380b8"; // placeholder txid
const paid = { settlementRef }; // in production: readSettlement(res).txid
const { receipt, bind } = dest.settle(destKp, {
  payloadId: manifest.payloadId, root: manifest.root, rail: "bsv", network: "bsv",
  settlementRef, payTo: "1LdqUbdZ6GY71KxThU6aKfuKXxgmTn82cv", amountAtomic: 5942,
}, paid);
line(`  bound to MY txid? ${ok(bind.ok)}`);
line(`  bound to a DIFFERENT txid? ${ok(dest.settle(destKp, { settlementRef }, { settlementRef: "0x" + "9".repeat(64) }).bind.reason === "settlementRef_not_mine")} (refused: settlementRef_not_mine)`);
line(`  UNBOUND refuses? ${ok(dest.settle(destKp, { settlementRef }, {}).bind.reason.startsWith("unbound"))}`);

line("\n== Summary ==");
line(`  chunks verified out of order, tamper rejected, custody chain intact, gap documented, delivery bound. Receipt ${receipt.claimId.slice(0, 18)}...`);
line("  (Real transport = BPv7/uD3TN + netem; real settlement = a live BSV txid. Both are marked seams.)");
