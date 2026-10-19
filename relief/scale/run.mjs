#!/usr/bin/env node
// Regional-scale relief run: fly three days of field traffic across the region, verify
// every bundle at the hub, settle the relay payouts, then attack the evidence six ways and
// confirm each attack is caught for exactly the bundles it touches and costs honest
// custodians nothing.
//   node relief/scale/run.mjs            480 clinics, 48 couriers, 16 relays, 3 days
//   node relief/scale/run.mjs --small    60 clinics, 12 couriers, 4 relays (seconds)
//   node relief/scale/run.mjs --write    also write relief/scale/RESULTS.md
//   node relief/scale/run.mjs --json     print the summary as JSON
import { writeFileSync } from "node:fs";
import os from "node:os";
import { genKeypair } from "../../agent/lib/keys.mjs";
import { signRecord } from "../../agent/lib/receipt.mjs";
import { batchReceipt } from "../../agent/lib/batch.mjs";
import { makeRegion, simulate, settle } from "./sim.mjs";

const small = process.argv.includes("--small");
const json = process.argv.includes("--json");
const cfg = small ? { districts: 4, couriersPer: 3, clinics: 60, days: 3, longOutageRelay: 1 } : { districts: 16, couriersPer: 3, clinics: 480, days: 3, longOutageRelay: 3 };
const fmt = (n) => Math.round(n).toLocaleString("en-US");
const secs = (t) => `${((performance.now() - t) / 1000).toFixed(1)} s`;
const say = (s = "") => { if (!json) console.log(s); };

let t = performance.now();
const region = makeRegion(cfg);
const tKeys = secs(t);
t = performance.now();
const { evidence, truth } = simulate(region, cfg);
const tSim = secs(t);
t = performance.now();
const base = settle(region, evidence);
const tSettle = secs(t);

const deliveredIds = new Set(evidence.delivered.map((d) => d.bundleId));
const totalBundles = truth.bundleMeta.size;
const sum = (o) => Object.values(o).reduce((s, p) => s + p.sats, 0);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const delta = (a, b) => Object.fromEntries([...new Set([...Object.keys(a), ...Object.keys(b)])].map((k) => [k, (b[k]?.handoffs ?? 0) - (a[k]?.handoffs ?? 0)]).filter(([, v]) => v));

say(`== Region: ${region.clinics.length} clinics, ${region.couriers.length} couriers, ${region.relays.length} satellite relays, ${cfg.days} days ==`);
say(`  ${fmt(truth.payloads)} payloads (${fmt(truth.attachments)} with attachments), ${fmt(totalBundles)} bundles, ${fmt(evidence.batches.length)} batch receipts`);
say(`  delivered ${fmt(deliveredIds.size)} | waiting at clinics ${fmt(truth.atClinics)} | in relay storage at the end ${fmt(truth.inStorage)}`);
say(`  carried via a neighbouring relay (road closed) ${fmt(truth.rerouted)} | held through a terminal outage ${fmt(truth.held)}`);
say(`  hub verified ${fmt(base.ok.size)} of ${fmt(deliveredIds.size)} delivered, ${base.failures.size} failures; ${fmt(base.missing.size)} signed-for but not yet delivered, each located`);

// ---- Attacks --------------------------------------------------------------------------------
const attacks = [];
const run = (name, mutate, expect) => {
  const ev = { manifests: new Map(evidence.manifests), bundles: new Map(evidence.bundles), delivered: [...evidence.delivered], batches: [...evidence.batches] };
  const ctx = mutate(ev);
  const res = settle(region, ev);
  const verdict = expect(res, ctx);
  attacks.push({ name, ...verdict });
  say(`  ${verdict.pass ? "PASS" : "FAIL"}  ${name}: ${verdict.detail}`);
};
const pick = (arr, n, step = 7) => arr.filter((_, i) => i % step === 0).slice(0, n);
const deliveredList = [...deliveredIds];
say("\n== Attacks ==");

run("chunk altered on a courier's phone (25 bundles)", (ev) => {
  const ids = pick(deliveredList, 25);
  for (const id of ids) { const b = { ...ev.bundles.get(id) }; const x = Buffer.from(b.bytesB64, "base64"); x[0] ^= 1; b.bytesB64 = x.toString("base64"); ev.bundles.set(id, b); }
  return { ids };
}, (res, { ids }) => {
  const failed = [...res.failures].filter(([, r]) => r === "leaf_hash_mismatch").map(([id]) => id);
  const pass = res.failures.size === ids.length && same(failed.sort(), [...ids].sort()) && res.ok.size === base.ok.size - ids.length;
  return { pass, affected: ids.length, caught: failed.length, detail: `${failed.length} of ${ids.length} refused (leaf_hash_mismatch), every other bundle still verifies` };
});

run("stolen courier identity re-signs a clinic pickup", (ev) => {
  const i = ev.batches.findIndex((b) => b.receipt.thisHop.includes("courier") && b.leaves.some((id) => deliveredIds.has(id)) && b.leaves.length > 10);
  const b = ev.batches[i];
  const { claimId, sig, signerPub, ...content } = b.receipt;
  ev.batches[i] = { ...b, receipt: signRecord(genKeypair(), content) };
  return { ids: b.leaves.filter((id) => deliveredIds.has(id)), courier: b.receipt.thisHop };
}, (res, { ids }) => {
  const failed = [...res.failures].filter(([, r]) => r === "signer_not_authorized").map(([id]) => id);
  const pass = res.failures.size === ids.length && same(failed.sort(), [...ids].sort());
  return { pass, affected: ids.length, caught: failed.length, detail: `${failed.length} of ${ids.length} bundles in that pickup refused (signer_not_authorized), no others` };
});

run("fake clinic report: manifest signed by an unknown key", (ev) => {
  const pid = [...ev.manifests.keys()].find((p) => p.endsWith("attachment") && deliveredList.some((id) => ev.bundles.get(id).payloadId === p));
  const { claimId, sig, signerPub, ...content } = ev.manifests.get(pid);
  ev.manifests.set(pid, signRecord(genKeypair(), content));
  return { ids: deliveredList.filter((id) => ev.bundles.get(id).payloadId === pid) };
}, (res, { ids }) => {
  const failed = [...res.failures].filter(([, r]) => r === "signer_not_pinned_source_key").map(([id]) => id);
  const pass = res.failures.size === ids.length && same(failed.sort(), [...ids].sort());
  return { pass, affected: ids.length, caught: failed.length, detail: `all ${failed.length} bundles of that payload refused (signer_not_pinned_source_key), no others` };
});

run("greedy courier claims 200 bundles another courier carried", (ev) => {
  const victim = ev.batches.filter((b) => b.receipt.thisHop.includes("courier") && b.leaves.length >= 3);
  const ids = [], greedy = region.couriers[0].eid;
  for (const b of victim) {
    if (b.receipt.thisHop === greedy) continue;
    const take = b.leaves.filter((id) => deliveredIds.has(id)).slice(0, 200 - ids.length);
    if (!take.length) continue;
    ev.batches.push(batchReceipt(region.keys.get(greedy), { prevHop: b.receipt.prevHop, thisHop: greedy, contactId: `fake#${ids.length}`, from: b.receipt.from, to: b.receipt.to, bundleIds: take }));
    ids.push(...take);
    if (ids.length >= 200) break;
  }
  return { ids, greedy };
}, (res, { ids, greedy }) => {
  const d = delta(base.payouts, res.payouts);
  const pass = res.ok.size === base.ok.size && res.failures.size === 0 && same(d, {});
  return { pass, affected: ids.length, caught: ids.length, detail: `all ${ids.length} still verify through the courier that really carried them; payouts unchanged (${greedy.slice(6, -5)} gains 0)` };
});

run("relay replays its batch records to be paid twice", (ev) => {
  const rel = ev.batches.filter((b) => b.receipt.thisHop.includes("relay")).slice(0, 50);
  ev.batches.push(...rel.map((b) => ({ ...b })));
  return { n: rel.length };
}, (res, { n }) => {
  const pass = res.ok.size === base.ok.size && same(res.payouts, base.payouts);
  return { pass, affected: n, caught: n, detail: `${n} replayed records change no payout (each handoff is paid once)` };
});

run("relay drops 60 bundles but signed for them", (ev) => {
  const relay = region.relays[0].eid;
  const ids = pick(ev.delivered.filter((d) => d.relay === relay).map((d) => d.bundleId), 60, 3);
  const drop = new Set(ids);
  ev.delivered = ev.delivered.filter((d) => !drop.has(d.bundleId));
  for (const id of ids) ev.bundles.delete(id);
  return { ids, relay };
}, (res, { ids, relay }) => {
  const located = ids.filter((id) => res.missing.get(id) === relay).length;
  const d = delta(base.payouts, res.payouts);
  const pass = located === ids.length && d[relay] === -ids.length && Object.keys(d).length === 1 && res.failures.size === 0;
  return { pass, affected: ids.length, caught: located, detail: `all ${located} located at ${relay.slice(6, -5)}, which loses ${-(d[relay] ?? 0)} handoffs; the couriers who handed them over are still paid` };
});

const allPass = attacks.every((a) => a.pass);
const summary = {
  ok: base.failures.size === 0 && base.ok.size === deliveredIds.size && allPass,
  region: { clinics: region.clinics.length, couriers: region.couriers.length, relays: region.relays.length, days: cfg.days },
  payloads: truth.payloads, attachments: truth.attachments, bundles: totalBundles, batchReceipts: evidence.batches.length,
  delivered: deliveredIds.size, verified: base.ok.size, failures: base.failures.size, signedNotDelivered: base.missing.size,
  waitingAtClinics: truth.atClinics, inRelayStorage: truth.inStorage, rerouted: truth.rerouted, heldThroughOutage: truth.held,
  longestHoldH: truth.holdTicks.length ? Math.max(...truth.holdTicks) / 6 : 0,
  payoutSats: sum(base.payouts), signatureChecks: base.signatureChecks,
  attacks: attacks.map(({ name, pass, affected, caught }) => ({ name, pass, affected, caught })),
  timing: { keys: tKeys, simulate: tSim, settle: tSettle },
};
say(`\n== Payouts: ${fmt(summary.payoutSats)} sats for proven handoffs, ${fmt(base.signatureChecks)} signature checks ==`);
say(`== ${summary.ok ? "All checks passed" : "SOME CHECKS FAILED"} (keys ${tKeys}, simulate ${tSim}, settle ${tSettle}) ==`);
if (json) console.log(JSON.stringify(summary, null, 2));

if (process.argv.includes("--write")) {
  const holdsH = truth.holdTicks.map((x) => x / 6).sort((a, b) => a - b);
  const pct = (p) => holdsH.length ? holdsH[Math.min(holdsH.length - 1, Math.floor(p * holdsH.length))].toFixed(1) : "0";
  const top = Object.entries(base.payouts).sort((a, b) => b[1].sats - a[1].sats);
  const md = `# Relief network at regional scale

Run ${new Date().toISOString().slice(0, 10)} on ${os.cpus()[0].model}, Node ${process.version}, one thread. Reproduce: \`node relief/scale/run.mjs --write\`.

## Setup

| | |
|---|---|
| Clinics | ${fmt(region.clinics.length)} across ${region.relays.length} districts |
| Couriers | ${region.couriers.length} (${cfg.couriersPer} per district), a different round of clinics every day |
| Satellite relays | ${region.relays.length}, one per district |
| Duration | ${cfg.days} days in 10-minute ticks |
| Traffic | a daily report from every clinic (2 chunks); an attachment of 8 to 40 KB on ${Math.round(0.15 * 100)}% of clinic-days |
| Road closures | on 20% of courier-days the courier hands over at a neighbouring district's relay |
| Terminal outages | 0 to 2 a day per relay, 1 to 12 hours each, and one relay down for 30 hours |
| Custody | one batch receipt per clinic pickup (courier) and per courier handoff (relay) |
| Signing keys | ${fmt(region.keys.size)}, generated in ${tKeys} |

## Delivery

| | |
|---|---|
| Payloads filed | ${fmt(truth.payloads)} (${fmt(truth.attachments)} attachments) |
| Bundles | ${fmt(totalBundles)} |
| Delivered to the hub | ${fmt(deliveredIds.size)} |
| Still waiting at a clinic (no courier visit yet) | ${fmt(truth.atClinics)} |
| In relay storage at the end (terminal still down) | ${fmt(truth.inStorage)} |
| Carried via a neighbouring relay | ${fmt(truth.rerouted)} |
| Held in relay storage through an outage | ${fmt(truth.held)} (median ${pct(0.5)} h, 95th percentile ${pct(0.95)} h, longest ${pct(1)} h) |
| Simulation time | ${tSim} |

## Verification and settlement at the hub

| | |
|---|---|
| Delivered bundles verified (chunk against the clinic's signed root, and path from clinic to uplinking relay under pinned keys) | ${fmt(base.ok.size)} of ${fmt(deliveredIds.size)} |
| Failures | ${base.failures.size} |
| Signed for but not yet delivered, each located at its last custodian | ${fmt(base.missing.size)} |
| Batch receipts | ${fmt(evidence.batches.length)}, ${fmt(base.signatureChecks)} signature checks (each record checked once) |
| Payouts (50 sats per proven handoff) | ${fmt(summary.payoutSats)} sats to ${top.length} couriers and relays; highest ${top[0][0].slice(6, -5)} ${fmt(top[0][1].sats)}, lowest ${top.at(-1)[0].slice(6, -5)} ${fmt(top.at(-1)[1].sats)} |
| Settlement time | ${tSettle} |

A custodian is paid for a bundle when its handoff is proven: by the next custodian's signed
receipt, or, for the last relay, by the hub receiving the bundle. So a courier is paid for what
it delivered to a relay even while that relay's terminal is still down.

## Attacks

Each attack runs on a copy of the evidence; the hub's verdict is compared with the bundles the
attack touched.

| Attack | Result |
|---|---|
${attacks.map((a) => `| ${a.name} | ${a.pass ? "PASS" : "FAIL"}: ${a.detail} |`).join("\n")}

## What this does and does not show

- Shown: at regional scale, with routes nobody planned in advance and long outages, every
  delivered bundle is verified from the records alone, every undelivered one is located at its
  last custodian, payouts follow proven handoffs only, and each attack is contained to exactly
  the bundles it touches.
- Modeled: the network (courier rounds, road closures, terminal outages) and the traffic, which is
  synthetic. Reports are not encrypted in this run; encryption is per payload and is exercised in
  \`relief/kit\` and \`relief/realnet\`.
- Assumed: batch records reach the hub (relays uplink their own and the couriers' records; a
  courier's phone also syncs its records whenever it has signal), so a relay that drops bundles
  cannot also hide the courier's record of handing them over.
`;
  writeFileSync(new URL("./RESULTS.md", import.meta.url), md);
  say("wrote relief/scale/RESULTS.md");
}
if (!summary.ok) process.exit(1);
