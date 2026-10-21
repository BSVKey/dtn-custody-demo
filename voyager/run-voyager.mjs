// Custody over DTN to and from Voyager 1, in virtual time (node voyager/run-voyager.mjs).
// Real agent code (chunk, Merkle, signed manifest, per-hop custody receipts, out-of-order
// verify, reassembly) over the contact-window link model in link.mjs, with Voyager's
// light time and data rates and an illustrative DSN track schedule from plan.json.
//
//   Downlink: VGR1 -(space, 160 bps)-> DSN -(ground)-> JPL -(ground)-> SCIENCE
//   Uplink:   JPL -(ground)-> DSN -(space, 16 bps)-> VGR1, then Voyager's signed
//             delivery receipt comes back down to JPL.
//
// --json prints one VOYAGER_RESULT line for tests and RESULTS.md.
import { readFileSync } from "node:fs";
import { genKeypair } from "../agent/lib/keys.mjs";
import { prepare } from "../agent/source.mjs";
import { makeRelay } from "../agent/relay.mjs";
import { makeDest } from "../agent/dest.mjs";
import { deliveryReceipt, verifyRecord } from "../agent/lib/receipt.mjs";
import { canonicalize } from "../agent/lib/canonical.mjs";
import { runPath, shiftWindows, wireBytes } from "./link.mjs";

const plan = JSON.parse(readFileSync(new URL("./plan.json", import.meta.url), "utf8"));
const json = process.argv.includes("--json");
const line = (s = "") => { if (!json) console.log(s); };
const ok = (b) => (b ? "PASS" : "FAIL");

const T = (iso) => Date.parse(iso);
const iso = (ms) => new Date(ms).toISOString().replace(".000Z", "Z");
const hours = (ms) => (ms / 3.6e6).toFixed(1) + " h";
const OWLT = Math.round(plan.oneWayLightTimeH * 3.6e6);
const tracks = plan.tracks.map(([s, e]) => [T(s), T(e)]);

const EID = { vgr: "dtn://voyager1/", dsn: "dtn://dsn/", jpl: "dtn://jpl/", sci: "dtn://science/" };
const kp = { vgr: genKeypair(), dsn: genKeypair(), jpl: genKeypair(), sci: genKeypair() };
const relay = (k) => makeRelay(kp[k], EID[k]);
const ground = (id) => ({ id, owltMs: plan.groundLinkMs, bps: 1e8, windows: null });

function payloadOf(label, n) {
  const base = Buffer.from(`${label} :: verifiable custody over DTN to Voyager 1 :: `, "utf8");
  return Buffer.concat(Array.from({ length: Math.ceil(n / base.length) }, () => base)).subarray(0, n);
}

// Carry one payload over a path and verify it at the far end. Returns the facts.
function carry({ name, srcKey, destKey, hops, relayKeys, links, spec }) {
  const payload = payloadOf(name, spec.bytes);
  const { manifest, bundles } = prepare(kp[srcKey], payload, { payloadId: `0x${name}`, chunkSize: spec.chunkSize });
  const items = bundles.map((b) => ({ bundle: b, bytes: wireBytes(b, plan.bundleOverheadBytes), readyAt: T(spec.readyAt) }));
  const relays = Object.fromEntries(relayKeys.map((k) => [EID[k], relay(k)]));
  const run = runPath({ hops, links, items, relays });

  const pinned = relayKeys.map((k) => ({ eid: EID[k], pub: kp[k].pub }));
  const dest = makeDest(kp[destKey], manifest, pinned, { sourcePub: kp[srcKey].pub });
  let accepted = 0;
  for (const a of run.arrivals) {
    if (dest.receiveBundle(a.bundle).ok) accepted++;
    for (const r of run.custodyByBundle.get(a.bundle.bundleId)) dest.recordCustody(a.bundle.bundleId, r);
  }
  const chainsOk = bundles.filter((b) => dest.verifyChain(b.bundleId).ok).length;
  const space = links.findIndex((l) => l.windows);
  const spaceLegs = run.legs.map((l) => l[space]);
  const wire = items.reduce((s, it) => s + it.bytes, 0);
  return {
    manifest, dest, run, payload, bundles: bundles.length, accepted, chainsOk,
    complete: dest.isComplete(), payloadMatches: dest.isComplete() && dest.reassemble().equals(payload),
    wireBytes: wire, overheadPct: +(100 * (wire - spec.bytes) / spec.bytes).toFixed(1),
    readyAt: T(spec.readyAt),
    firstTx: Math.min(...spaceLegs.map((l) => l.txStart)),
    lastTxEnd: Math.max(...spaceLegs.map((l) => l.txEnd)),
    firstArrival: run.arrivals[0].at, lastArrival: run.arrivals.at(-1).at,
    spaceTransitOk: spaceLegs.every((l) => l.arriveAt - l.txEnd === OWLT),
    outOfOrder: run.arrivals.some((a, i) => a.bundle.index !== i),
  };
}

function report(title, r, spaceLinkId) {
  line(`\n== ${title} ==`);
  line(`  payload ${r.payload.length} B in ${r.bundles} bundles, ${r.wireBytes} B on the space link (Merkle + headers +${r.overheadPct}%)`);
  line(`  ready ${iso(r.readyAt)}`);
  line(`  space link ${spaceLinkId}: first bit ${iso(r.firstTx)}, last bit ${iso(r.lastTxEnd)}`);
  for (const g of r.run.gaps.filter((g) => g.link === spaceLinkId)) {
    line(`  held ${g.bundlesDelayed.length} bundles: no window ${g.downAt ? iso(g.downAt) : "(before ready)"} to ${iso(g.upAt)}`);
  }
  line(`  first arrival ${iso(r.firstArrival)}, last ${iso(r.lastArrival)} (${hours(r.lastArrival - r.readyAt)} after ready)`);
  line(`  every space hop took exactly one light time: ${ok(r.spaceTransitOk)}`);
  line(`  chunks verified vs Merkle root ${r.accepted}/${r.bundles}, custody chains ${r.chainsOk}/${r.bundles}, reassembled ${ok(r.payloadMatches)}`);
}

line(`== ${plan.spacecraft}: one-way light time ${plan.oneWayLightTimeH} h, down ${plan.downlinkBps} bps, up ${plan.uplinkBps} bps ==`);
line(`  ${plan.lightTimeNote}`);
line(`  ${plan.tracksNote}`);
for (const [s, e] of tracks) line(`  DSN track ${iso(s)} to ${iso(e)}`);

// ---- Downlink: Voyager transmits one light time before each track ----
const vgrTx = shiftWindows(tracks, -OWLT);
const down = carry({
  name: "voyager1-science", srcKey: "vgr", destKey: "sci",
  hops: [EID.vgr, EID.dsn, EID.jpl, EID.sci], relayKeys: ["dsn", "jpl"],
  links: [{ id: "VGR1-DSN", owltMs: OWLT, bps: plan.downlinkBps, windows: vgrTx }, ground("DSN-JPL"), ground("JPL-SCI")],
  spec: plan.downlink,
});
line(`\n  Voyager may transmit only ${plan.oneWayLightTimeH} h before a track, so its windows are the tracks moved earlier:`);
for (const [s, e] of vgrTx.slice(0, 3)) line(`  VGR1 transmit ${iso(s)} to ${iso(e)}`);
line(`  No track on 2026-10-22, so nothing Voyager sends 2026-10-21 06:12 to 14:12 would be heard.`);
report("Downlink: science frame VGR1 -> DSN -> JPL -> science team", down, "VGR1-DSN");

// ---- Uplink: DSN transmits during tracks; Voyager always listens ----
const up = carry({
  name: "voyager1-command", srcKey: "jpl", destKey: "vgr",
  hops: [EID.jpl, EID.dsn, EID.vgr], relayKeys: ["dsn"],
  links: [ground("JPL-DSN"), { id: "DSN-VGR1", owltMs: OWLT, bps: plan.uplinkBps, windows: tracks }],
  spec: plan.uplink,
});
report("Uplink: command load JPL -> DSN -> VGR1", up, "DSN-VGR1");

// Voyager signs a delivery receipt for the whole command load (no payment on this path)
// and sends it down in its next transmit window.
const ack = deliveryReceipt(kp.vgr, {
  payloadId: up.manifest.payloadId, root: up.manifest.root, rail: "none", network: "none",
  settlementRef: null, payTo: null, amountAtomic: 0,
});
const ackBytes = Buffer.byteLength(canonicalize(ack)) + plan.bundleOverheadBytes;
const ackRun = runPath({
  hops: [EID.vgr, EID.dsn, EID.jpl], relays: { [EID.dsn]: relay("dsn") },
  links: [{ id: "VGR1-DSN", owltMs: OWLT, bps: plan.downlinkBps, windows: vgrTx }, ground("DSN-JPL")],
  items: [{ bundle: { payloadId: ack.payloadId, bundleId: ack.claimId, index: 0 }, bytes: ackBytes, readyAt: up.lastArrival }],
});
const ackAt = ackRun.arrivals[0].at;
const ackV = verifyRecord(ack);
const ackOk = ackV.ok && ackV.signer === kp.vgr.pub && ack.root === up.manifest.root;
line(`  Voyager's signed delivery receipt (${ackBytes} B) leaves ${iso(ackRun.legs[0][0].txStart)}, reaches JPL ${iso(ackAt)}`);
line(`  receipt verifies under Voyager's pinned key and names the command's Merkle root: ${ok(ackOk)}`);
line(`  command ready to delivery confirmed at JPL: ${hours(ackAt - up.readyAt)}`);

// ---- Tamper control on the uplink ----
const victim = { ...up.run.arrivals[0].bundle };
const bad = Buffer.from(victim.bytesB64, "base64"); bad[0] ^= 0xff; victim.bytesB64 = bad.toString("base64");
const tamperRejected = !up.dest.receiveBundle(victim).ok;
line(`\n== Tamper control: one flipped bit in a command chunk is rejected by Voyager: ${ok(tamperRejected)} ==`);

const result = {
  ok: down.complete && down.payloadMatches && down.chainsOk === down.bundles && down.spaceTransitOk
    && up.complete && up.payloadMatches && up.chainsOk === up.bundles && up.spaceTransitOk && ackOk && tamperRejected,
  oneWayLightTimeH: plan.oneWayLightTimeH,
  downlink: {
    bundles: down.bundles, accepted: down.accepted, custodyChains: down.chainsOk, payloadMatches: down.payloadMatches,
    ready: iso(down.readyAt), firstArrival: iso(down.firstArrival), lastArrival: iso(down.lastArrival),
    heldByGaps: down.run.gaps.map((g) => g.bundlesDelayed.length), overheadPct: down.overheadPct,
  },
  uplink: {
    bundles: up.bundles, accepted: up.accepted, custodyChains: up.chainsOk, payloadMatches: up.payloadMatches,
    ready: iso(up.readyAt), firstArrival: iso(up.firstArrival), lastArrival: iso(up.lastArrival),
    heldByGaps: up.run.gaps.map((g) => g.bundlesDelayed.length), overheadPct: up.overheadPct,
    deliveryReceiptAtJpl: iso(ackAt), readyToConfirmedH: +((ackAt - up.readyAt) / 3.6e6).toFixed(1),
  },
  tamperRejected,
};
line(`\n== ${result.ok ? "PASS" : "FAIL"} (virtual time; nothing waits a light day) ==`);
if (json) console.log("VOYAGER_RESULT " + JSON.stringify(result));
process.exitCode = result.ok ? 0 : 1;
