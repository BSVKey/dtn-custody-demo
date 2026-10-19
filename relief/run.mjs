#!/usr/bin/env node
// Disaster-relief walk-through. The cell network is down after an earthquake. Two field
// clinics send their daily reports (patients seen, referrals, supplies needed) to the
// district coordination hub by store-and-forward: clinic tablet -> motorbike courier ->
// village relay with a satellite terminal -> hub. The terminal loses power for 70
// minutes mid-transfer.
//
// What it shows, offline and deterministic:
//   - reports are encrypted to the hub, so the courier and relay carry only ciphertext;
//   - the hub verifies every chunk and every custody handoff, whatever order they arrive in;
//   - the power cut becomes a gap record, not an unexplained silence;
//   - relay operators are paid only for custody they can prove, and a fake relay gets nothing;
//   - a chunk altered on the courier's phone is rejected.
//
//   node relief/run.mjs            readable walk-through
//   node relief/run.mjs --json     the hub's evidence as JSON
import { readFileSync } from "node:fs";
import { createCipheriv, createDecipheriv, createPublicKey, diffieHellman, generateKeyPairSync, hkdfSync, randomBytes } from "node:crypto";
import { genKeypair, prepare, makeRelay, makeDest, gapObject, verifyCustodyChain } from "../index.mjs";
import { simulate, defaultSimPlan } from "../transport/sim.mjs";
import { toSimPlan } from "../contact-plans/compile.mjs";

const json = process.argv.includes("--json");
const say = (s = "") => { if (!json) console.log(s); };
const mins = (ms) => `${Math.round(ms / 60000)} min`;

// ---- End-to-end encryption to the hub: X25519 + HKDF-SHA256 + AES-256-GCM ------------
// The hub's encryption key is provisioned on each clinic tablet before deployment. The
// custody layer signs and verifies the ciphertext; only the hub can read the report.
function sealTo(hubPub, plaintext, aad) {
  const eph = generateKeyPairSync("x25519");
  const key = Buffer.from(hkdfSync("sha256", diffieHellman({ privateKey: eph.privateKey, publicKey: hubPub }), Buffer.alloc(0), "relief-report/1", 32));
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key, iv).setAAD(aad);
  const ct = Buffer.concat([c.update(plaintext), c.final()]);
  const epk = eph.publicKey.export({ type: "spki", format: "der" });
  return Buffer.concat([Buffer.from([epk.length]), epk, iv, c.getAuthTag(), ct]);
}
function openAt(hubPriv, sealed, aad) {
  const n = sealed[0], epk = createPublicKey({ key: sealed.subarray(1, 1 + n), format: "der", type: "spki" });
  const iv = sealed.subarray(1 + n, 13 + n), tag = sealed.subarray(13 + n, 29 + n), ct = sealed.subarray(29 + n);
  const key = Buffer.from(hkdfSync("sha256", diffieHellman({ privateKey: hubPriv, publicKey: epk }), Buffer.alloc(0), "relief-report/1", 32));
  const d = createDecipheriv("aes-256-gcm", key, iv).setAAD(aad);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(ct), d.final()]);
}

// ---- Who is in the network -------------------------------------------------------------
const EID = { courier: "dtn://courier-07/", village: "dtn://village-relay-kalo/", hub: "dtn://district-hub/" };
const courierKp = genKeypair(), villageKp = genKeypair(), hubKp = genKeypair();
const hubEnc = generateKeyPairSync("x25519");
const pinnedHops = [{ eid: EID.courier, pub: courierKp.pub }, { eid: EID.village, pub: villageKp.pub }];
const relays = { [EID.courier]: makeRelay(courierKp, EID.courier), [EID.village]: makeRelay(villageKp, EID.village) };
const RATE_SATS = 50; // what the hub pays a relay operator per bundle it can prove it carried

const scenario = JSON.parse(readFileSync(new URL("./scenario.json", import.meta.url), "utf8"));

// Synthetic reports (no real patients).
const clinics = [
  { id: "clinic-north", kp: genKeypair(), report: {
    clinic: "North field clinic", date: "2026-10-19", patientsSeen: 42, referrals: 3,
    conditions: { injuries: 17, respiratory: 9, diarrhoeal: 11, other: 5 },
    urgent: ["2 patients need surgical transfer"],
    supplies: { "ORS sachets": 200, "tetanus vaccine": 60, "wound dressings": 150 },
  } },
  { id: "clinic-river", kp: genKeypair(), report: {
    clinic: "River crossing clinic", date: "2026-10-19", patientsSeen: 27, referrals: 1,
    conditions: { injuries: 8, respiratory: 4, diarrhoeal: 13, other: 2 },
    urgent: ["suspected cholera cluster: 6 cases"],
    supplies: { "ORS sachets": 400, "water purification tablets": 5000, "IV fluids": 40 },
  } },
];

say("== Relief network: cell towers down, data moves by courier and satellite ==");
for (const n of scenario.nodes) say(`  ${n.name}`);
say(`  satellite terminal out of power from ${mins(scenario.occultation.down_s * 1000)} to ${mins(scenario.occultation.up_s * 1000)} into the run`);

const evidence = { clinics: [], payouts: {}, refused: [] };
const custodied = new Map([[EID.courier, new Set()], [EID.village, new Set()]]);
let allOk = true;
const check = (cond) => { if (!cond) allOk = false; return cond ? "PASS" : "FAIL"; };

for (const c of clinics) {
  say(`\n== ${c.report.clinic}: encrypt, chunk, sign ==`);
  const plaintext = Buffer.from(JSON.stringify(c.report), "utf8");
  const payloadId = `${c.id}/2026-10-19`;
  const sealed = sealTo(hubEnc.publicKey, plaintext, Buffer.from(payloadId));
  const { manifest, bundles } = prepare(c.kp, sealed, { payloadId, chunkSize: 64 });
  say(`  report ${plaintext.length} bytes -> ciphertext ${sealed.length} bytes in ${bundles.length} bundles | root ${manifest.root.slice(0, 18)}...`);

  const plan = toSimPlan(scenario, { ...defaultSimPlan, hops: [`dtn://${c.id}/`, EID.courier, EID.village, EID.hub], jitterMs: 90000, processMs: 30000 }, { bundles: bundles.length });
  const sim = simulate({ plan, bundles, relays });
  say(`  ${sim.delayed.length} of ${bundles.length} bundles waited at the village relay through the power cut`);

  // The hub pins the clinic's signing key and the relays' keys from its own records.
  const hub = makeDest(hubKp, manifest, pinnedHops, { sourcePub: c.kp.pub });
  for (const b of sim.arrivalOrder) {
    if (!hub.receiveBundle(b).ok) continue;
    for (const r of sim.custodyByBundle.get(b.bundleId)) hub.recordCustody(b.bundleId, r);
  }
  const chains = bundles.map((b) => [b.bundleId, hub.verifyChain(b.bundleId)]);
  for (const [id, v] of chains) if (v.ok) for (const h of pinnedHops) custodied.get(h.eid).add(id);
  const report = JSON.parse(openAt(hubEnc.privateKey, hub.reassemble(), Buffer.from(payloadId)).toString("utf8"));
  const order = sim.arrivalOrder.map((b) => b.index);

  say(`  hub: every chunk verified ${check(hub.isComplete())} | arrived out of order ${order.some((v, i) => v !== i) ? "yes" : "no"} | custody chains intact ${check(chains.every(([, v]) => v.ok))}`);
  say(`  hub: decrypted report matches what the clinic sent ${check(JSON.stringify(report) === JSON.stringify(c.report))}`);
  const leaked = bundles.some((b) => Buffer.from(b.bytesB64, "base64").includes(Buffer.from(c.report.clinic.slice(0, 5))));
  say(`  courier and relay carried ciphertext only? ${check(!leaked && !sealed.includes(Buffer.from(c.report.clinic)))}`);
  say(`  -> ${report.patientsSeen} patients, ${report.referrals} referral${report.referrals === 1 ? "" : "s"}; URGENT: ${report.urgent.join("; ")}`);
  say(`  -> needs: ${Object.entries(report.supplies).map(([k, v]) => `${v} ${k}`).join(", ")}`);

  const gap = gapObject({ link: sim.occultedLink, linkEvents: sim.linkEvents, delayed: sim.delayed, lost: sim.lost });
  say(`  gap record: ${gap.link} (village -> hub) down ${mins(gap.durationMs)}, ${gap.bundlesDelayed.length} bundles delayed, ${gap.bundlesLostConfirmed.length} lost`);

  // Attacks on this report.
  const victim = { ...sim.arrivalOrder[0] };
  const bad = Buffer.from(victim.bytesB64, "base64"); bad[5] ^= 0x01; victim.bytesB64 = bad.toString("base64");
  const tamper = hub.receiveBundle(victim);
  say(`  chunk altered on the courier's phone rejected? ${check(!tamper.ok)} (${tamper.reason})`);

  evidence.clinics.push({ payloadId, root: manifest.root, bundles: bundles.length, complete: hub.isComplete(), gap, report });
}

// ---- Paying the relay operators -------------------------------------------------------
// One payment per relay operator for every bundle whose custody chain verified. The fake
// relay below claims to be courier-07 for a bundle it never carried, signing with its own
// key: the hub pins courier-07's real key, so the claim fails and earns nothing.
say("\n== Paying relay operators for custody they can prove ==");
const someBundle = [...custodied.get(EID.courier)][0];
const ghostClaim = makeRelay(genKeypair(), EID.courier).stamp({ payloadId: "clinic-north/2026-10-19", bundleId: someBundle }, "dtn://clinic-north/", 0, 1);
const ghostCheck = verifyCustodyChain([ghostClaim], { bundleId: someBundle, hops: [pinnedHops[0]] });
evidence.refused.push({ claimedHop: ghostClaim.thisHop, bundleId: someBundle, reason: ghostCheck.reason });
for (const [eid, ids] of custodied) {
  evidence.payouts[eid] = { bundles: ids.size, sats: ids.size * RATE_SATS };
  say(`  ${eid.padEnd(26)} ${String(ids.size).padStart(3)} bundles x ${RATE_SATS} sats = ${ids.size * RATE_SATS} sats`);
}
say(`  impostor posing as courier-07: claim refused ${check(!ghostCheck.ok)} (${ghostCheck.reason})`);
const total = Object.values(evidence.payouts).reduce((s, p) => s + p.sats, 0);
say(`  total ${total} sats to relay operators. Real BSV payouts and on-chain proofs: live/ and constellation/MAIN-RESULTS.md`);

say(`\n== ${allOk ? "All checks passed" : "SOME CHECKS FAILED"} ==`);
evidence.ok = allOk;
if (json) console.log(JSON.stringify(evidence, null, 2));
if (!allOk) process.exit(1);
