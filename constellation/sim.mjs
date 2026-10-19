// Constellation-scale custody: thousands of satellites, routes that change mid-transfer,
// one batch receipt per node per contact, and verification of every bundle's path.
//
// Model (deliberately simple, deterministic from a seed):
//   - P orbital planes x S satellites (default 72 x 56 = 4,032), node ipn:(1000 + p*S + s).
//   - Inter-satellite links: in-plane neighbours always up; cross-plane neighbours up
//     except near the poles (a band that moves with time) and except random per-epoch
//     failures. Links are symmetric.
//   - G ground stations; each sees the few satellites passing over it this epoch, so
//     station access moves every epoch. Stations forward to mission operations ipn:9.0.
//   - Bundles start at random satellites (onboard instruments) and must reach ipn:9.0.
//     Every tick each bundle moves one hop toward the nearest satellite that currently
//     sees a station (routes are recomputed every epoch from where the bundle IS), or
//     waits in storage if its node is cut off.
//   - Custody: each node signs ONE custody-batch/1 per (previous hop, epoch) covering
//     every bundle it received from that neighbour in that epoch.
// The ground then gathers all batch records, rebuilds each bundle's path, and verifies it
// with verifyPath under the node key directory (or any authorizer passed in).
import { genKeypair } from "../agent/lib/keys.mjs";
import { contentId } from "../agent/lib/canonical.mjs";
import { custodyReceipt } from "../agent/lib/receipt.mjs";
import { batchReceipt, batchProof } from "../agent/lib/batch.mjs";
import { verifyPath, pinnedDirectory, assemblePath } from "../agent/lib/path.mjs";

export const MOC = "ipn:9.0";

function rng(seed) { // mulberry32
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

export function makeConstellation({ planes = 72, perPlane = 56, stations = 40, seed = 7, keysFor } = {}) {
  const sats = [];
  for (let p = 0; p < planes; p++) for (let s = 0; s < perPlane; s++) sats.push({ p, s, eid: `ipn:${1000 + p * perPlane + s}.0` });
  const gs = Array.from({ length: stations }, (_, g) => ({ eid: `ipn:${100 + g}.0`, p: Math.floor((g * planes) / stations), s0: Math.floor((g * 7919) % perPlane) }));
  const nodes = [...sats.map((x) => x.eid), ...gs.map((x) => x.eid), MOC];
  const keys = new Map(nodes.map((eid) => [eid, keysFor ? keysFor(eid) : genKeypair()]));
  return { planes, perPlane, sats, gs, keys, seed, nodes };
}

// Optical inter-satellite link mode (links: "optical"). All numbers are modeled from public
// sources, not taken from any operator's system:
//   rate          10 Gbps (ESTOL-OOK-43010) or 99.5328 Gbps (ESTOL-HCO-31010), ESA ESTOL v3.1
//                 (ESA-CSC-T-SP-0001, 2026), which builds on the SDA Optical Communications
//                 Terminal standard (SDA 9100-001-09 v4.0.0) and CCSDS 141.11-O-1
//   acquisition   a cross-plane link that comes (back) up is unusable for acqS seconds; ESTOL
//                 asks re-acquisition below 10 s (ESTOL-PAT-00050), so 10 s is the default
//   max range     5,500 km, the link range a vendor datasheet gives for an SDA OCT v3.x
//                 terminal with a 70 mm aperture (a vendor figure, not an SDA requirement)
//   geometry      the grid as a Walker delta shell: 550 km altitude, 53 degrees inclination,
//                 planes spread over 360 degrees of right ascension, phasing factor 1; slot
//                 phase 0 is the highest latitude, where the cross-plane band is off
//   capacity      rate x tick / (8 x bundleBytes) bundles per directed link per tick (ISLs
//                 only; station downlinks keep the RF model)
// Intra-plane links are persistent; cross-plane links are persistent while in range and out
// of the high-latitude band, and every time one comes up it must be acquired again. Links
// up in the first epoch count as already acquired.
export const OPTICAL = {
  rates: { "10G": 10.0e9, "100G": 99.5328e9 },
  acqS: 10, maxRangeKm: 5500, altKm: 550, incDeg: 53, bundleBytes: 1048576,
};
const RE_KM = 6378.137, C_KM_S = 299792.458;
function shellPosition(c, p, s, epoch) {
  const R = RE_KM + OPTICAL.altKm, inc = (OPTICAL.incDeg * Math.PI) / 180;
  const raan = (2 * Math.PI * p) / c.planes;
  const u = (2 * Math.PI * ((s + epoch) % c.perPlane)) / c.perPlane + Math.PI / 2 + (2 * Math.PI * p) / (c.planes * c.perPlane);
  return [R * (Math.cos(u) * Math.cos(raan) - Math.sin(u) * Math.cos(inc) * Math.sin(raan)),
    R * (Math.cos(u) * Math.sin(raan) + Math.sin(u) * Math.cos(inc) * Math.cos(raan)), R * Math.sin(u) * Math.sin(inc)];
}

// Topology for one epoch: adjacency among satellites plus which satellites see which station.
function topology(c, epoch, rand, failRate, stationUpRate = 1, optical = null) {
  const { planes: P, perPlane: S } = c;
  const id = (p, s) => p * S + s;
  const adj = Array.from({ length: P * S }, () => []);
  const link = (a, b) => { adj[a].push(b); adj[b].push(a); };
  const polar = (s) => { const phase = (s + epoch) % S; return phase < 3 || Math.abs(phase - S / 2) < 3; };
  let down = 0;
  const cross = new Set(), km = optical ? [] : null;
  const dist = (a, b) => { const x = shellPosition(c, a[0], a[1], epoch), y = shellPosition(c, b[0], b[1], epoch); return Math.hypot(x[0] - y[0], x[1] - y[1], x[2] - y[2]); };
  for (let p = 0; p < P; p++) for (let s = 0; s < S; s++) {
    if (optical) {
      const d = dist([p, s], [p, (s + 1) % S]);
      if (d <= OPTICAL.maxRangeKm) { link(id(p, s), id(p, (s + 1) % S)); km.push(d); } else down++;
    } else link(id(p, s), id(p, (s + 1) % S));
    if (p + 1 < P) {
      if (polar(s) || rand() < failRate) down++;
      else if (optical) {
        const d = dist([p, s], [p + 1, s]);
        if (d <= OPTICAL.maxRangeKm) { link(id(p, s), id(p + 1, s)); cross.add(id(p, s) * 65536 + id(p + 1, s)); km.push(d); } else down++;
      } else link(id(p, s), id(p + 1, s));
    }
  }
  const sees = new Map(); // sat index -> station eid
  let stationsUp = 0;
  for (const g of c.gs) {
    if (stationUpRate < 1 && rand() >= stationUpRate) continue; // station offline this epoch
    stationsUp++;
    const s = (g.s0 + epoch) % S;
    for (const dp of [0, 1]) if (g.p + dp < P) sees.set(id(g.p + dp, s), g.eid);
  }
  return { adj, sees, crossLinksDown: down, stationsUp, cross, km };
}

// Multi-source BFS from every satellite that currently sees a station.
function distances(t) {
  const d = new Int32Array(t.adj.length).fill(-1);
  const q = [];
  for (const i of t.sees.keys()) { d[i] = 0; q.push(i); }
  for (let h = 0; h < q.length; h++) for (const n of t.adj[q[h]]) if (d[n] < 0) { d[n] = d[q[h]] + 1; q.push(n); }
  return d;
}

// keyAt(node, time), when given, picks the signing key in force at that time (for key
// rotation during the run); otherwise each node signs with its one key in c.keys.
// links: "rf" (default, the grid model above) or "optical" (OPTICAL above): optical adds link
// range, acquisition after every cross-plane link comes up, per-link capacity, and signs one
// batch per node per contact, where a contact lasts as long as the link stays up (across
// epochs), instead of one per node, neighbour and epoch. bundleBytes sets the bundle size
// used for link capacity.
export function simulate(c, { bundles = 10000, epochs = 40, ticksPerEpoch = 10, failRate = 0.02, stationUpRate = 1, injectEpochs = 10, seed = c.seed, keyAt, links = "rf", rate = "10G", acqS = OPTICAL.acqS, bundleBytes = OPTICAL.bundleBytes } = {}) {
  const optical = links === "optical" ? { rate: OPTICAL.rates[rate], acqS } : null;
  if (links !== "rf" && !optical?.rate) throw new Error(`simulate: unknown links "${links}" or rate "${rate}"`);
  if (optical && c.topology) throw new Error("simulate: optical links need the grid model, not c.topology");
  const rand = rng(seed);
  const satIndex = new Map(c.sats.map((x, i) => [x.eid, i]));
  const inflight = [];
  const done = [];
  const batches = []; // { receipt, leaves, tree }
  let hopEvents = 0, storedTicks = 0, sampleReceiptBytes = 0, blackoutEpochs = 0;
  const perEpoch = Math.ceil(bundles / injectEpochs);
  const t0 = Date.parse("2026-10-01T00:00:00Z");
  const tickMs = 6000;
  const opt = optical && {
    acqTicks: Math.ceil((optical.acqS * 1000) / tickMs),
    perTick: Math.floor((optical.rate * tickMs) / 1000 / (8 * bundleBytes)),
    acquisitions: 0, acquireWaits: 0, capacityWaits: 0, maxKm: 0, sumKm: 0, nKm: 0,
  };
  const sign = (r, contactId) => {
    const kp = keyAt ? keyAt(r.node, r.from) : c.keys.get(r.node);
    batches.push(batchReceipt(kp, { prevHop: r.prev, thisHop: r.node, contactId, from: r.from, to: r.to, bundleIds: r.ids }));
  };
  const open = new Map(); // optical: contacts still open, kept across epochs
  let prevCross = null;

  for (let e = 0; e < epochs; e++) {
    // A constellation may bring its own topology source (for example real orbits); otherwise
    // the grid model above is used.
    const topo = c.topology ? c.topology(e) : topology(c, e, rand, failRate, stationUpRate, optical);
    if (topo.stationsUp === 0) blackoutEpochs++;
    const dist = distances(topo);
    let acquiring = null;
    if (opt) {
      // Cross-plane links that were down last epoch must be acquired again before use.
      acquiring = prevCross ? new Set([...topo.cross].filter((x) => !prevCross.has(x))) : new Set();
      opt.acquisitions += acquiring.size;
      prevCross = topo.cross;
      for (const d of topo.km) { opt.sumKm += d; opt.nKm++; if (d > opt.maxKm) opt.maxKm = d; }
      // A contact ends when its link is down; sign it then. The source app and the ground
      // network (station to operations) never drop.
      const up = (r) => {
        if (r.prev.startsWith("app:") || r.node === MOC) return true;
        const a = satIndex.get(r.prev), b = satIndex.get(r.node);
        return b === undefined ? topo.sees.get(a) === r.node : topo.adj[a].includes(b);
      };
      for (const [k, r] of open) if (!up(r)) { sign(r, `c${r.e}:${r.prev}>${r.node}`); open.delete(k); }
    }
    const received = opt ? open : new Map(); // `${node}|${prev}` -> { ids, from, to }
    const take = (node, prev, bundleId, t) => {
      const k = `${node}|${prev}`;
      const r = received.get(k) || { node, prev, ids: [], from: t, to: t, e };
      r.ids.push(bundleId); r.to = Math.max(r.to, t); r.from = Math.min(r.from, t);
      received.set(k, r);
      hopEvents++;
    };
    if (e < injectEpochs) {
      for (let i = 0; i < perEpoch && inflight.length + done.length < bundles; i++) {
        const src = c.sats[Math.floor(rand() * c.sats.length)];
        const b = { bundleId: contentId({ n: inflight.length + done.length, seed }), source: `app:${src.eid}`, at: src.eid, path: [src.eid], born: e, waited: 0, minHops: dist[satIndex.get(src.eid)] < 0 ? null : dist[satIndex.get(src.eid)] + 2 };
        take(src.eid, b.source, b.bundleId, t0 + e * ticksPerEpoch * tickMs);
        inflight.push(b);
      }
    }
    for (let k = 0; k < ticksPerEpoch; k++) {
      const t = t0 + (e * ticksPerEpoch + k) * tickMs;
      const load = opt ? new Map() : null; // directed ISL -> bundles sent this tick
      for (let j = inflight.length - 1; j >= 0; j--) {
        const b = inflight[j];
        let next = null;
        if (b.at === MOC) continue;
        if (!satIndex.has(b.at)) next = MOC; // a ground station forwards to operations
        else {
          const i = satIndex.get(b.at);
          if (topo.sees.has(i)) next = topo.sees.get(i);
          else if (dist[i] > 0) {
            let cand = topo.adj[i].filter((n) => dist[n] === dist[i] - 1);
            if (opt && cand.length) {
              const acquired = cand.filter((n) => k >= opt.acqTicks || !acquiring.has(Math.min(i, n) * 65536 + Math.max(i, n)));
              const free = acquired.filter((n) => (load.get(i * 65536 + n) || 0) < opt.perTick);
              if (!acquired.length) opt.acquireWaits++; else if (!free.length) opt.capacityWaits++;
              cand = free;
            }
            next = cand.length ? c.sats[cand[Math.floor(rand() * cand.length)]].eid : null;
            if (opt && next) { const x = i * 65536 + satIndex.get(next); load.set(x, (load.get(x) || 0) + 1); }
          }
        }
        if (!next) { storedTicks++; b.waited++; continue; }
        take(next, b.at, b.bundleId, t);
        b.path.push(next);
        b.at = next;
        if (next === MOC) { b.arrived = e; done.push(b); inflight.splice(j, 1); }
      }
    }
    // RF: one batch receipt per (node, previous hop) for this epoch. Optical: contacts stay
    // open until their link drops.
    if (!opt) for (const r of received.values()) sign(r, `e${e}:${r.prev}>${r.node}`);
  }
  if (opt) for (const r of open.values()) sign(r, `c${r.e}:${r.prev}>${r.node}`); // end of run
  // Route change evidence: bundles still in flight when the topology changed (their route
  // was recomputed from where they were), bundles that waited in storage, and bundles
  // whose delivered path was longer than the shortest path at the moment they started.
  const crossedEpoch = done.filter((b) => b.arrived > b.born).length;
  const waited = done.filter((b) => b.waited > 0).length;
  const detoured = done.filter((b) => b.minHops !== null && b.path.length - 1 > b.minHops).length;
  const sample = custodyReceipt(genKeypair(), { payloadId: "0xp", bundleId: done[0]?.bundleId || "0x", prevHop: "ipn:1000.0", thisHop: "ipn:1001.0", receivedAt: t0, forwardedAt: t0 + 1 });
  sampleReceiptBytes = Buffer.byteLength(JSON.stringify(sample));
  const opticalStats = opt && {
    rate, acqS, bundleBytes, acqTicks: opt.acqTicks, bundlesPerLinkTick: opt.perTick, acquisitions: opt.acquisitions,
    acquireWaits: opt.acquireWaits, capacityWaits: opt.capacityWaits,
    meanLinkKm: opt.nKm ? opt.sumKm / opt.nKm : 0, maxLinkKm: opt.maxKm, maxLightMs: (opt.maxKm / C_KM_S) * 1000,
  };
  return { delivered: done, stranded: inflight, batches, hopEvents, storedTicks, sampleReceiptBytes, crossedEpoch, waited, detoured, blackoutEpochs, optical: opticalStats || null };
}

// Ground side: index every batch by bundle, rebuild and verify each delivered bundle.
export function epochStart(e, ticksPerEpoch = 10) { return Date.parse("2026-10-01T00:00:00Z") + e * ticksPerEpoch * 6000; }

export function verifyAll(c, run, { authorize, maxHops = 256 } = {}) {
  const auth = authorize || pinnedDirectory(new Map([...c.keys].map(([eid, kp]) => [eid, kp.pub])));
  const byBundle = new Map();
  for (const b of run.batches) for (const id of b.leaves) {
    const list = byBundle.get(id) || [];
    list.push(b);
    byBundle.set(id, list);
  }
  const cache = new Map();
  const failures = {};
  let ok = 0, hops = 0, revisitPaths = 0;
  for (const d of run.delivered) {
    const entries = (byBundle.get(d.bundleId) || []).map((b) => ({ receipt: b.receipt, proof: batchProof(b, d.bundleId) }));
    const path = assemblePath(entries, d.source);
    const v = verifyPath(path, { bundleId: d.bundleId, source: d.source, destination: MOC, authorize: auth, maxHops, cache });
    if (v.ok) { ok++; hops += v.hops; if (v.revisits) revisitPaths++; } else failures[v.reason] = (failures[v.reason] || 0) + 1;
  }
  return { verified: ok, failed: run.delivered.length - ok, failures, avgHops: ok ? hops / ok : 0, signatureChecks: cache.size, revisitPaths };
}
