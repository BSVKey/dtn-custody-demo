// Custody over DTN to and from a Voyager, in virtual time. Real agent code (chunk, Merkle,
// signed manifest, per-hop custody receipts, out-of-order verify, reassembly) over the
// contact-window link model in link.mjs. Link windows come only from a DSN schedule signed
// as a dtn.contact-plan/1 record (schedule.mjs).
//
//   Downlink: VGR -(space)-> DSN -(ground)-> JPL -(ground)-> SCIENCE; NACKs ride the uplink
//   Uplink:   JPL -(ground)-> DSN -(space)-> VGR, then the spacecraft's signed delivery
//             receipt comes back down to JPL; NACKs ride the downlink
import { readFileSync } from "node:fs";
import { genKeypair } from "../agent/lib/keys.mjs";
import { prepare } from "../agent/source.mjs";
import { makeRelay } from "../agent/relay.mjs";
import { makeDest } from "../agent/dest.mjs";
import { deliveryReceipt, verifyRecord } from "../agent/lib/receipt.mjs";
import { canonicalize } from "../agent/lib/canonical.mjs";
import { runPath, wireBytes } from "./link.mjs";
import { missionPlan, signSchedule, windowsFrom, gapBackedByPlan } from "./schedule.mjs";

export const MISSIONS = JSON.parse(readFileSync(new URL("./missions.json", import.meta.url), "utf8"));

const T = (iso) => Date.parse(iso);
export const iso = (ms) => new Date(ms).toISOString().replace(".000Z", "Z");
const hours = (ms) => (ms / 3.6e6).toFixed(1) + " h";
const ok = (b) => (b ? "PASS" : "FAIL");

export function runMission(key = "voyager1", { ber = 0, seed = 7, downChunk, log = () => {} } = {}) {
  const base = MISSIONS[key], common = MISSIONS.common;
  if (!base) throw new Error(`unknown mission ${key}`);
  const m = downChunk ? { ...base, downlink: { ...base.downlink, chunkSize: downChunk } } : base;
  const OWLT = Math.round(m.oneWayLightTimeH * 3.6e6);
  const tag = m.ipn === 1 ? "VGR1" : "VGR2";
  const EID = { vgr: `dtn://${tag.toLowerCase()}/`, dsn: "dtn://dsn/", jpl: "dtn://jpl/", sci: "dtn://science/" };
  const kp = { vgr: genKeypair(), dsn: genKeypair(), jpl: genKeypair(), sci: genKeypair(), sched: genKeypair() };
  const relay = (k) => makeRelay(kp[k], EID[k]);
  const ground = (id) => ({ id, owltMs: common.groundLinkMs, bps: 1e8, windows: null });

  // ---- The signed schedule: the only source of link windows ----
  const plan = missionPlan(m, common);
  const planRec = signSchedule(kp.sched, plan);
  const upW = windowsFrom(planRec, plan, kp.sched.pub, "UP");
  const downW = windowsFrom(planRec, plan, kp.sched.pub, "DOWN");
  const edited = structuredClone(plan); edited.contacts[0].down_s += 60;
  let editRefused = false;
  try { windowsFrom(planRec, edited, kp.sched.pub, "UP"); } catch { editRefused = true; }

  log(`== ${m.spacecraft}: one-way light time ${m.oneWayLightTimeH} h, down ${m.downlinkBps} bps, up ${m.uplinkBps} bps${ber ? `, bit error rate ${ber}` : ""} ==`);
  log(`  ${m.lightTimeNote}`);
  log(`  ${m.tracksNote}`);
  log(`  schedule signed as dtn.contact-plan/1 ${planRec.claimId.slice(0, 18)}... (${plan.contacts.length} contacts, ION + HDTN exports fingerprinted)`);
  log(`  windows read only from the verified plan; a copy with one contact moved 60 s is refused: ${ok(editRefused)}`);
  log(`  ${tag} may transmit only ${m.oneWayLightTimeH} h before a track; can be commanded on ${upW.length} of ${downW.length} tracks`);

  const payloadOf = (label, n) => {
    const base = Buffer.from(`${label} :: verifiable custody over DTN to ${m.spacecraft} :: `, "utf8");
    return Buffer.concat(Array.from({ length: Math.ceil(n / base.length) }, () => base)).subarray(0, n);
  };

  function carry({ name, srcKey, destKey, hops, relayKeys, links, spec, spaceId }) {
    const payload = payloadOf(name, spec.bytes);
    const { manifest, bundles } = prepare(kp[srcKey], payload, { payloadId: `0x${name}`, chunkSize: spec.chunkSize });
    const items = bundles.map((b) => ({ bundle: b, bytes: wireBytes(b, common.bundleOverheadBytes), readyAt: T(spec.readyAt) }));
    const relays = Object.fromEntries(relayKeys.map((k) => [EID[k], relay(k)]));
    const run = runPath({ hops, links, items, relays, seed });
    const pinned = relayKeys.map((k) => ({ eid: EID[k], pub: kp[k].pub }));
    const dest = makeDest(kp[destKey], manifest, pinned, { sourcePub: kp[srcKey].pub });
    let accepted = 0;
    for (const a of run.arrivals) {
      if (dest.receiveBundle(a.bundle).ok) accepted++;
      for (const r of run.custodyByBundle.get(a.bundle.bundleId)) dest.recordCustody(a.bundle.bundleId, r);
    }
    const s = links.findIndex((l) => l.id === spaceId);
    const spaceLegs = run.legs.map((l) => l[s]);
    const spaceGaps = run.gaps.filter((g) => g.link === spaceId).map((g) => ({ ...g, plan: planRec.claimId }));
    const planLink = spaceId.endsWith("DSN") ? "DOWN" : "UP";
    return {
      manifest, dest, run, payload, bundles: bundles.length, accepted,
      chainsOk: bundles.filter((b) => dest.verifyChain(b.bundleId).ok).length,
      complete: dest.isComplete(), payloadMatches: dest.isComplete() && dest.reassemble().equals(payload),
      wireBytes: items.reduce((a, it) => a + it.bytes, 0),
      overheadPct: +(100 * (items.reduce((a, it) => a + it.bytes, 0) - spec.bytes) / spec.bytes).toFixed(1),
      readyAt: T(spec.readyAt),
      firstTx: Math.min(...spaceLegs.map((l) => l.txStart)), lastTxEnd: Math.max(...spaceLegs.map((l) => l.txEnd)),
      firstArrival: run.arrivals[0].at, lastArrival: run.arrivals.at(-1).at,
      spaceTransitOk: spaceLegs.every((l) => l.arriveAt - l.txEnd === OWLT),
      spaceGaps, gapsBacked: spaceGaps.every((g) => gapBackedByPlan(g, plan, planLink)),
      resends: run.resends.filter((r) => r.link === spaceId),
    };
  }

  function report(title, r, spaceId) {
    log(`\n== ${title} ==`);
    log(`  payload ${r.payload.length} B in ${r.bundles} bundles, ${r.wireBytes} B on the space link (Merkle + headers +${r.overheadPct}%)`);
    log(`  ready ${iso(r.readyAt)}`);
    log(`  space link ${spaceId}: first bit ${iso(r.firstTx)}, last bit ${iso(r.lastTxEnd)}`);
    for (const g of r.spaceGaps) {
      log(`  held ${g.bundlesDelayed.length} bundles: no window ${g.downAt ? iso(g.downAt) : "(before ready)"} to ${iso(g.upAt)}`);
    }
    if (r.spaceGaps.length) log(`  every gap record names the signed plan and no contact was in force inside it: ${ok(r.gapsBacked)}`);
    for (const x of r.resends) {
      log(`  round ${x.round}: ${x.bundleIds.length} lost; NACK sent ${iso(x.nackSentAt)}, at the sender ${iso(x.nackArriveAt)}`);
    }
    log(`  first arrival ${iso(r.firstArrival)}, last ${iso(r.lastArrival)} (${hours(r.lastArrival - r.readyAt)} after ready)`);
    log(`  every space hop took exactly one light time: ${ok(r.spaceTransitOk)}`);
    log(`  chunks verified vs Merkle root ${r.accepted}/${r.bundles}, custody chains ${r.chainsOk}/${r.bundles}, reassembled ${ok(r.payloadMatches)}`);
  }

  const upLink = { id: `DSN-${tag}`, owltMs: OWLT, bps: m.uplinkBps, windows: upW, ber };
  const downLink = { id: `${tag}-DSN`, owltMs: OWLT, bps: m.downlinkBps, windows: downW, ber };
  // A NACK for the downlink rides the uplink (commanding tracks only), and vice versa.
  const downWithNack = { ...downLink, reverse: { owltMs: OWLT, bps: m.uplinkBps, windows: upW } };
  const upWithNack = { ...upLink, reverse: { owltMs: OWLT, bps: m.downlinkBps, windows: downW } };

  const down = carry({
    name: `${key}-science`, srcKey: "vgr", destKey: "sci", spaceId: downLink.id,
    hops: [EID.vgr, EID.dsn, EID.jpl, EID.sci], relayKeys: ["dsn", "jpl"],
    links: [downWithNack, ground("DSN-JPL"), ground("JPL-SCI")], spec: m.downlink,
  });
  report(`Downlink: science frame ${tag} -> DSN -> JPL -> science team`, down, downLink.id);

  const up = carry({
    name: `${key}-command`, srcKey: "jpl", destKey: "vgr", spaceId: upLink.id,
    hops: [EID.jpl, EID.dsn, EID.vgr], relayKeys: ["dsn"],
    links: [ground("JPL-DSN"), upWithNack], spec: m.uplink,
  });
  report(`Uplink: command load JPL -> DSN -> ${tag}`, up, upLink.id);

  // The spacecraft signs a delivery receipt for the whole command load (no payment on
  // this path) and sends it down in its next transmit window (lossless here).
  const ack = deliveryReceipt(kp.vgr, {
    payloadId: up.manifest.payloadId, root: up.manifest.root, rail: "none", network: "none",
    settlementRef: null, payTo: null, amountAtomic: 0,
  });
  const ackBytes = Buffer.byteLength(canonicalize(ack)) + common.bundleOverheadBytes;
  const ackRun = runPath({
    hops: [EID.vgr, EID.dsn, EID.jpl], relays: { [EID.dsn]: relay("dsn") },
    links: [{ ...downLink, ber: 0 }, ground("DSN-JPL")],
    items: [{ bundle: { payloadId: ack.payloadId, bundleId: ack.claimId, index: 0 }, bytes: ackBytes, readyAt: up.lastArrival }],
  });
  const ackAt = ackRun.arrivals[0].at;
  const ackV = verifyRecord(ack);
  const ackOk = ackV.ok && ackV.signer === kp.vgr.pub && ack.root === up.manifest.root;
  log(`  ${tag}'s signed delivery receipt (${ackBytes} B) leaves ${iso(ackRun.legs[0][0].txStart)}, reaches JPL ${iso(ackAt)}`);
  log(`  receipt verifies under ${tag}'s pinned key and names the command's Merkle root: ${ok(ackOk)}`);
  log(`  command ready to delivery confirmed at JPL: ${hours(ackAt - up.readyAt)}`);

  const victim = { ...up.run.arrivals[0].bundle };
  const bad = Buffer.from(victim.bytesB64, "base64"); bad[0] ^= 0xff; victim.bytesB64 = bad.toString("base64");
  const tamperRejected = !up.dest.receiveBundle(victim).ok;
  log(`\n== Tamper control: one flipped bit in a command chunk is rejected by ${tag}: ${ok(tamperRejected)} ==`);

  const side = (r) => ({
    bundles: r.bundles, accepted: r.accepted, custodyChains: r.chainsOk, payloadMatches: r.payloadMatches,
    ready: iso(r.readyAt), firstArrival: iso(r.firstArrival), lastArrival: iso(r.lastArrival),
    hoursToLast: +((r.lastArrival - r.readyAt) / 3.6e6).toFixed(1),
    heldByGaps: r.spaceGaps.map((g) => g.bundlesDelayed.length), gapsBacked: r.gapsBacked,
    lostAndResent: r.resends.reduce((a, x) => a + x.bundleIds.length, 0), nackRounds: r.resends.length,
    overheadPct: r.overheadPct,
  });
  const good = (r) => r.complete && r.payloadMatches && r.chainsOk === r.bundles && r.spaceTransitOk && r.gapsBacked;
  const result = {
    ok: good(down) && good(up) && ackOk && tamperRejected && editRefused,
    mission: key, oneWayLightTimeH: m.oneWayLightTimeH, ber, seed, plan: planRec.claimId, editRefused,
    downlink: side(down),
    uplink: { ...side(up), deliveryReceiptAtJpl: iso(ackAt), readyToConfirmedH: +((ackAt - up.readyAt) / 3.6e6).toFixed(1) },
    tamperRejected,
  };
  log(`\n== ${result.ok ? "PASS" : "FAIL"} (virtual time; nothing waits a light day) ==`);
  return result;
}
