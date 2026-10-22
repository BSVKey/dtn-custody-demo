// End-to-end demo (make demo): chunk -> Merkle -> multi-hop store-and-forward with a
// scripted occultation -> out-of-order Merkle verification -> per-hop custody receipts
// -> gap object across the blackout -> delivery bound to a settlement. Fully offline.
//
// Offline, `settlementRef` is a placeholder. With --live (read-only, spends nothing) the
// demo carries live/anchored-payload.txt, checks on Bitcoin BSV mainnet that its manifest
// root is in the anchor transaction's OP_RETURN, and binds delivery to a real settlement
// verified on chain (live/pinned.mjs). For your own anchor: build it with
// live/build-anchor.mjs, broadcast it yourself, then
//   node run-demo.mjs --live --payload <file> --anchor <txid>
import { genKeypair } from "./agent/lib/keys.mjs";
import { prepare } from "./agent/source.mjs";
import { makeRelay } from "./agent/relay.mjs";
import { makeDest } from "./agent/dest.mjs";
import { gapObject } from "./agent/lib/gap.mjs";
import { readFileSync } from "node:fs";
import { simulate, defaultSimPlan } from "./transport/sim.mjs";
import { toSimPlan, normalize } from "./contact-plans/compile.mjs";
import { verifyDeliveryLive } from "./live/verify-delivery-live.mjs";
import { SETTLEMENT, ANCHOR_TXID, ANCHORED_PAYLOAD } from "./live/pinned.mjs";

// Optional mission schedule: node run-demo.mjs --plan contact-plans/mars-relay.json
const planArg = process.argv.indexOf("--plan");
const missionPlan = planArg > 0 ? JSON.parse(readFileSync(process.argv[planArg + 1], "utf8")) : null;
const opt = (k) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : undefined; };
const LIVE = process.argv.includes("--live");
if (LIVE && opt("--payload") && !opt("--anchor")) {
  console.error("--payload needs --anchor <txid>: the transaction that anchors that payload's root (live/build-anchor.mjs)");
  process.exit(2);
}

const line = (s = "") => console.log(s);
const ok = (b) => (b ? "PASS" : "FAIL");

// Four node identities + a delivery signer (the destination signs delivery here).
const source = genKeypair();
const relayaKp = genKeypair();
const relaybKp = genKeypair();
const destKp = genKeypair();

const EID = { src: "dtn://source/", a: "dtn://relaya/", b: "dtn://relayb/", dst: "dtn://dest/" };

// A payload (stand-in for a rover image / short clip): ~1.2 KB over 64-byte chunks. Live, the
// payload whose root is anchored on chain.
const payload = LIVE ? readFileSync(opt("--payload") ?? ANCHORED_PAYLOAD) : Buffer.from(
  "OPEN SOURCE DTN CUSTODY DEMO :: " +
    "verifiable data custody and relay-payment over a delay/disruption-tolerant link. " +
    "This payload is chunked, Merkle-committed, carried across three hops with a " +
    "scripted occultation, verified out of order against the manifest root, custody-" +
    "stamped at every relay, and delivered bound to a settlement. ".repeat(6),
  "utf8",
);

line("== Source: chunk + Merkle + signed manifest ==");
const { manifest, bundles } = prepare(source, payload, { payloadId: "0xrover-frame-001", chunkSize: 64 });
line(`  payloadId ${manifest.payloadId} | chunks ${manifest.chunkCount} | root ${manifest.root.slice(0, 18)}...`);

const plan = missionPlan ? toSimPlan(missionPlan, defaultSimPlan, { bundles: bundles.length }) : defaultSimPlan;
if (missionPlan) {
  const p = normalize(missionPlan);
  line(`\n== Mission schedule: ${p.name} ==`);
  for (const l of p.links) {
    const from = p.nodes.find((n) => n.ipn === l.from)?.name, to = p.nodes.find((n) => n.ipn === l.to)?.name;
    line(`  ${l.id} ${from} -> ${to}: one-way light time ${p.delays[l.id].one_way_ms / 1000} s`);
  }
  if (p.occultation) line(`  outage on ${p.occultation.link}: ${p.occultation.down_s} s to ${p.occultation.up_s} s${p.occultation.cause ? ` (${p.occultation.cause})` : ""}`);
  line(`  simulated at scale ${p.scale ?? 1} (virtual time; nothing waits)`);
}
line("\n== Transport: 3 hops, reorder + occultation (compressed) ==");
const relays = { [EID.a]: makeRelay(relayaKp, EID.a), [EID.b]: makeRelay(relaybKp, EID.b) };
const sim = simulate({ plan, bundles, relays });
line(`  occulted link ${sim.occultedLink} down@${plan.occultation.downMs}ms up@${plan.occultation.upMs}ms`);
line(`  bundles held by the blackout: ${sim.delayed.length} of ${bundles.length}`);
const inOrder = sim.arrivalOrder.map((b) => b.index);
line(`  arrival order (first 12): ${inOrder.slice(0, 12).join(", ")}${inOrder.length > 12 ? " ..." : ""}`);
line(`  out of order? ${missionPlan ? (inOrder.some((v, i) => v !== i) ? "yes" : "no (bundle spacing exceeded jitter)") : ok(inOrder.some((v, i) => v !== i))}`);

line("\n== Destination: verify each chunk against the root, out of order ==");
const pinnedHops = [{ eid: EID.a, pub: relayaKp.pub }, { eid: EID.b, pub: relaybKp.pub }];
const dest = makeDest(destKp, manifest, pinnedHops, { sourcePub: source.pub });
let accepted = 0, rejected = 0;
for (const bundle of sim.arrivalOrder) {
  const r = dest.receiveBundle(bundle);
  if (r.ok) { accepted++; for (const rec of sim.custodyByBundle.get(bundle.bundleId)) dest.recordCustody(bundle.bundleId, rec); }
  else rejected++;
}
line(`  accepted ${accepted} | rejected ${rejected} | complete ${ok(dest.isComplete())}`);
const refusedReason = (fn) => { try { fn(); return null; } catch (e) { return e.reason; } };
const stranger = prepare(genKeypair(), Buffer.from("forgery ".repeat(200)), { payloadId: "0xframe", chunkSize: 64 }).manifest;
line(`  stranger-signed manifest refused? ${ok(refusedReason(() => makeDest(destKp, stranger, pinnedHops, { sourcePub: source.pub })) === "signer_not_pinned_source_key")} (refused: signer_not_pinned_source_key)`);
line(`  UNPINNED source refuses? ${ok(refusedReason(() => makeDest(destKp, manifest, pinnedHops)) === "unpinned")}`);
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
{
  const { verifyCustodyChain } = await import("./agent/lib/receipt.mjs");
  const forged = dest._custody.get(sample).map((r, i) => (i === 1 ? { ...r, sig: "AAAA" } : r));
  const res = verifyCustodyChain(forged, { bundleId: sample, hops: pinnedHops });
  line(`  forged hop detected? ${ok(!res.ok)} ${res.ok ? "" : "(" + res.reason + ")"}`);
}

line("\n== Gap object across the occultation ==");
const gap = gapObject({ link: sim.occultedLink, linkEvents: sim.linkEvents, delayed: sim.delayed, lost: sim.lost });
line(`  ${gap.kind} link ${gap.link} down@${gap.downAt}ms up@${gap.upAt}ms duration ${gap.durationMs}ms delayed ${gap.bundlesDelayed.length} lost ${gap.bundlesLostConfirmed.length}`);

line("\n== Delivery bound to the settlement the verifier paid ==");
// Offline a placeholder txid; live the real settlement the verifier paid (production:
// readSettlement(res).txid of the payment for this delivery).
const settlementRef = LIVE ? SETTLEMENT.settlementRef : "0x4e40b7bf86a0ca24f9746f3b6b5178def04b3a29024e4c7c9f8b95099ce380b8";
const paid = { settlementRef };
const { receipt, bind } = dest.settle(destKp, {
  payloadId: manifest.payloadId, root: manifest.root, rail: "bsv", network: "bsv",
  settlementRef, payTo: SETTLEMENT.payTo, amountAtomic: SETTLEMENT.amountAtomic,
}, paid);
line(`  bound to MY txid? ${ok(bind.ok)}`);
line(`  bound to a DIFFERENT txid? ${ok(dest.settle(destKp, { settlementRef }, { settlementRef: "0x" + "9".repeat(64) }).bind.reason === "settlementRef_not_mine")} (refused: settlementRef_not_mine)`);
line(`  UNBOUND refuses? ${ok(dest.settle(destKp, { settlementRef }, {}).bind.reason.startsWith("unbound"))}`);

let liveOk = true;
if (LIVE) {
  const anchorTxid = opt("--anchor") ?? ANCHOR_TXID;
  line("\n== Live: Bitcoin BSV mainnet (read-only, nothing is spent) ==");
  const res = await verifyDeliveryLive(receipt, paid, { minSats: SETTLEMENT.amountAtomic, minConf: 1, anchorTxid });
  liveOk = res.ok;
  if (res.ok) {
    line(`  manifest root in anchor tx ${anchorTxid}? PASS (${res.anchor.confirmations} conf)`);
    line(`  settlement ${settlementRef} on chain? PASS (${res.settlement.paidSats} sats to ${res.settlement.payTo}, ${res.settlement.confirmations} conf)`);
  } else {
    line(`  FAIL at ${res.stage}: ${res.reason || JSON.stringify(res)}`);
  }
}

line("\n== Summary ==");
line(`  chunks verified out of order, tamper rejected, custody chain intact, gap documented, delivery bound. Receipt ${receipt.claimId.slice(0, 18)}...`);
line(LIVE
  ? `  Live: manifest root anchored and settlement verified on Bitcoin BSV mainnet: ${ok(liveOk)}.`
  : "  (Real transport = BPv7/uD3TN + netem; real settlement and anchor: node run-demo.mjs --live.)");
if (!liveOk) process.exitCode = 1;
