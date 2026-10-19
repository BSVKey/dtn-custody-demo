// Regional-scale relief network: hundreds of clinics, dozens of couriers and satellite
// relays, routes that change day to day, terminals that lose power, one batch receipt per
// custody handoff, and an accounting that pays each custodian only for handoffs it can prove.
//
// Model (deterministic from a seed; one tick = 10 minutes):
//   - R districts, each with one village relay (satellite terminal) and C couriers, and K
//     clinics spread across the districts.
//   - Every morning each clinic files a daily report (2 chunks); some days it also sends an
//     attachment (16 to 80 chunks). Bundles wait at the clinic until a courier visits.
//   - Each courier rides a different set of its district's clinics every day, then hands
//     everything to a relay: its own district's on most days, a neighbouring one when the
//     road is closed. So the route of any bundle is not known in advance.
//   - Terminals lose power or sky: random outages of 1 to 12 hours, and one terminal down for
//     30 hours. Bundles wait in the relay's storage and go up when the terminal is back.
//   - Custody: a courier signs ONE custody-batch/1 per clinic visit, covering every bundle it
//     took there; a relay signs ONE per courier handoff. Relays uplink their batch records and
//     the couriers' with the bundles.
// The hub then verifies every bundle (chunk against its clinic's signed root, path from
// clinic to the relay that uplinked it under pinned keys) and settles payouts.
import { genKeypair } from "../../agent/lib/keys.mjs";
import { prepare } from "../../agent/source.mjs";
import { makeDest } from "../../agent/dest.mjs";
import { batchReceipt, batchProof } from "../../agent/lib/batch.mjs";
import { verifyPath, pinnedDirectory } from "../../agent/lib/path.mjs";

export const HUB = "dtn://district-hub.dtn/";
const TICK = 10 * 60_000;
const T0 = Date.parse("2026-10-19T00:00:00Z");

function rng(seed) { // mulberry32
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

export function makeRegion({ districts = 16, couriersPer = 3, clinics = 480, seed = 11 } = {}) {
  const relays = Array.from({ length: districts }, (_, d) => ({ eid: `dtn://relay-${String(d).padStart(2, "0")}.dtn/`, d }));
  const couriers = relays.flatMap((r) => Array.from({ length: couriersPer }, (_, i) => ({ eid: `dtn://courier-${String(r.d).padStart(2, "0")}${String.fromCharCode(97 + i)}.dtn/`, d: r.d })));
  const clinicList = Array.from({ length: clinics }, (_, k) => ({ eid: `dtn://clinic-${String(k).padStart(3, "0")}.dtn/`, d: k % districts }));
  const keys = new Map([...relays, ...couriers, ...clinicList].map((n) => [n.eid, genKeypair()]));
  return { relays, couriers, clinics: clinicList, keys, seed, districts };
}

// Fly the traffic. Returns the hub's evidence (what actually arrived) plus ground truth.
export function simulate(region, { days = 3, attachmentRate = 0.15, longOutageRelay = 3, uplinkPerTick = 4000 } = {}) {
  const rand = rng(region.seed);
  const ticks = days * 144;
  const ri = (a, b) => a + Math.floor(rand() * (b - a + 1));
  const { relays, couriers, clinics, keys } = region;

  // Terminal outages per relay: [fromTick, toTick).
  const outages = new Map(relays.map((r) => [r.eid, []]));
  for (const r of relays) for (let day = 0; day < days; day++) {
    for (let n = ri(0, 2); n > 0; n--) { const from = day * 144 + ri(0, 143); outages.get(r.eid).push([from, from + ri(6, 72)]); }
  }
  outages.get(relays[longOutageRelay].eid).push([144 + 60, 144 + 60 + 180]); // 30 hours from day 2, 10:00
  const down = (eid, t) => outages.get(eid).some(([a, b]) => t >= a && t < b);

  const manifests = new Map();     // payloadId -> manifest
  const bundleMeta = new Map();    // bundleId -> { bundle, clinic, payloadId }
  const clinicQueue = new Map(clinics.map((c) => [c.eid, []]));
  const courierBag = new Map(couriers.map((c) => [c.eid, []]));
  const relayStore = new Map(relays.map((r) => [r.eid, []]));
  const batches = [];
  const delivered = [];            // { bundleId, relay, at }
  let payloads = 0, attachments = 0, rerouted = 0, held = 0;
  const holdTicks = [];

  for (let day = 0; day < days; day++) {
    // 07:00 clinics file reports.
    for (const c of clinics) {
      const make = (kind, bytes) => {
        const payloadId = `${c.eid.slice(6, -5)}/${day}-${kind}`;
        const { manifest, bundles } = prepare(keys.get(c.eid), bytes, { payloadId, chunkSize: 512, meta: { clinic: c.eid, day } });
        manifests.set(payloadId, manifest);
        for (const b of bundles) { bundleMeta.set(b.bundleId, { bundle: b, clinic: c.eid, payloadId, filedAt: day * 144 + 42 }); clinicQueue.get(c.eid).push(b.bundleId); }
        payloads++;
      };
      make("report", Buffer.from(JSON.stringify({ clinic: c.eid, day, patientsSeen: ri(5, 80), pad: "x".repeat(ri(560, 900)) })));
      if (rand() < attachmentRate) { attachments++; make("attachment", Buffer.alloc(ri(8, 40) * 1024, ri(0, 255))); }
    }
    // Courier rounds: each courier visits a fresh random subset of its district's clinics
    // between 08:00 and 12:00, then rides to a relay (a neighbouring one if the road is closed).
    for (const k of couriers) {
      const mine = clinics.filter((c) => c.d === k.d);
      const visits = mine.filter(() => rand() < 0.45).sort(() => rand() - 0.5);
      let t = day * 144 + 48;
      for (const c of visits) {
        t += ri(1, 3);
        const ids = clinicQueue.get(c.eid).splice(0);
        if (!ids.length) continue;
        batches.push(batchReceipt(keys.get(k.eid), { prevHop: c.eid, thisHop: k.eid, contactId: `${k.eid}@${c.eid}#${t}`, from: T0 + t * TICK, to: T0 + t * TICK + 5 * 60_000, bundleIds: ids }));
        courierBag.get(k.eid).push(...ids);
      }
      const roadClosed = rand() < 0.2;
      const relay = relays[roadClosed ? (k.d + (rand() < 0.5 ? 1 : relays.length - 1)) % relays.length : k.d];
      if (roadClosed) rerouted += courierBag.get(k.eid).length;
      const at = Math.max(t, day * 144 + 72) + ri(3, 18); // 12:00 + 30 min to 3 h ride
      const ids = courierBag.get(k.eid).splice(0);
      if (!ids.length) continue;
      batches.push(batchReceipt(keys.get(relay.eid), { prevHop: k.eid, thisHop: relay.eid, contactId: `${relay.eid}@${k.eid}#${at}`, from: T0 + at * TICK, to: T0 + at * TICK + 10 * 60_000, bundleIds: ids }));
      for (const id of ids) relayStore.get(relay.eid).push({ id, since: at });
    }
    // Uplink tick by tick for this day: a terminal that is up sends what it holds.
    for (let t = day * 144; t < (day + 1) * 144; t++) {
      for (const r of relays) {
        const store = relayStore.get(r.eid);
        if (!store.length || down(r.eid, t)) continue;
        const go = store.filter((s) => s.since <= t).slice(0, uplinkPerTick);
        const sent = new Set(go.map((s) => s.id));
        relayStore.set(r.eid, store.filter((s) => !sent.has(s.id)));
        for (const s of go) {
          delivered.push({ bundleId: s.id, relay: r.eid, at: T0 + t * TICK + 2 * 60_000 });
          const waited = t - s.since;
          if (waited > 1) { held++; holdTicks.push(waited); }
        }
      }
    }
  }
  const inStorage = [...relayStore.values()].reduce((s, a) => s + a.length, 0);
  const atClinics = [...clinicQueue.values()].reduce((s, a) => s + a.length, 0);
  return {
    // What the hub holds: the manifests and bundles that arrived, and every batch record
    // (relays uplink theirs and the couriers'; couriers also sync theirs when they get signal).
    evidence: { manifests, bundles: new Map(delivered.map((d) => [d.bundleId, bundleMeta.get(d.bundleId).bundle])), delivered, batches },
    truth: { bundleMeta, payloads, attachments, rerouted, held, holdTicks, inStorage, atClinics, outages, ticks, days },
  };
}

// The hub's accounting, from the evidence alone.
//   delivered bundles: chunk verified against its clinic's signed root, and a path from the
//                      clinic to the relay that uplinked it that verifies under the pinned keys.
//   payouts:           a custodian is paid for a bundle when its handoff is proven: by the next
//                      custodian's signed receipt, or, for the last relay, by the hub receiving it.
//   undelivered:       located at the last custodian whose receipt for it verifies.
export function settle(region, evidence, { ratePerHandoffSats = 50 } = {}) {
  const { manifests, bundles, delivered, batches } = evidence;
  const directory = new Map([...region.keys].map(([eid, kp]) => [eid, kp.pub]));
  const authorize = pinnedDirectory(directory);
  const clinicOf = new Map(region.clinics.map((c) => [c.eid, c]));
  const relaySet = new Set(region.relays.map((r) => r.eid));
  const cache = new Map();
  const dests = new Map();

  // bundleId -> batches that cover it (with inclusion proofs computed lazily).
  const covering = new Map();
  batches.forEach((b, i) => { for (const id of b.leaves) { if (!covering.has(id)) covering.set(id, []); covering.get(id).push(i); } });

  // Every path from the clinic through the records that cover this bundle (normally one;
  // more when someone signed extra claims), shortest first.
  const paths = (bundleId, source) => {
    const entries = (covering.get(bundleId) || []).map((i) => ({ receipt: batches[i].receipt, proof: batchProof(batches[i], bundleId) })).filter((e) => e.proof);
    const out = [];
    const walk = (at, path, depth) => {
      if (path.length) out.push(path);
      if (depth > 4) return;
      for (const e of entries) if (e.receipt.prevHop === at && !path.includes(e)) walk(e.receipt.thisHop, [...path, e], depth + 1);
    };
    walk(source, [], 0);
    return out.sort((a, b) => b.length - a.length);
  };

  const ok = new Set(), failures = new Map(), paid = new Map(), missing = new Map();
  const pay = (eid, id) => { if (!paid.has(eid)) paid.set(eid, new Set()); paid.get(eid).add(id); };
  const deliveredIds = new Map();
  for (const d of delivered) if (!deliveredIds.has(d.bundleId)) deliveredIds.set(d.bundleId, d);

  for (const [id, d] of deliveredIds) {
    const b = bundles.get(id);
    const m = b && manifests.get(b.payloadId);
    const clinic = m?.meta?.clinic;
    if (!b || !m || !clinicOf.has(clinic)) { failures.set(id, "unknown_payload"); continue; }
    let dest = dests.get(b.payloadId);
    if (dest === undefined) {
      try { dest = makeDest({}, m, [], { sourcePub: directory.get(clinic) }); } catch (e) { dest = { error: e.reason || e.message }; }
      dests.set(b.payloadId, dest);
    }
    if (dest.error) { failures.set(id, dest.error); continue; }
    const r = dest.receiveBundle(b);
    if (!r.ok) { failures.set(id, r.reason); continue; }
    let firstFail = null, good = null;
    for (const links of paths(id, clinic)) {
      if (!relaySet.has(links[links.length - 1].receipt.thisHop) || links[links.length - 1].receipt.thisHop !== d.relay) continue;
      const v = verifyPath(links, { bundleId: id, source: clinic, destination: d.relay, authorize, cache });
      if (v.ok) { good = links; break; }
      firstFail ??= v.reason;
    }
    if (!good) { failures.set(id, firstFail || "no_custody_path"); continue; }
    ok.add(id);
    for (const l of good) pay(l.receipt.thisHop, id);
  }

  // Bundles some custodian signed for but the hub never received: the hub knows them from
  // the batch records alone, and starts each path at the clinic that handed it over.
  for (const id of covering.keys()) {
    if (deliveredIds.has(id)) continue;
    const clinic = covering.get(id).map((i) => batches[i].receipt.prevHop).find((e) => clinicOf.has(e));
    if (!clinic) continue;
    for (const links of paths(id, clinic)) {
      const last = links[links.length - 1].receipt.thisHop;
      const v = verifyPath(links, { bundleId: id, source: clinic, destination: last, authorize, cache });
      if (!v.ok) continue;
      missing.set(id, last);
      for (const l of links.slice(0, -1)) pay(l.receipt.thisHop, id); // handed on, proven by the next receipt
      break;
    }
  }

  const payouts = Object.fromEntries([...paid].map(([eid, ids]) => [eid, { handoffs: ids.size, sats: ids.size * ratePerHandoffSats }]));
  return { ok, failures, missing, payouts, signatureChecks: cache.size };
}
