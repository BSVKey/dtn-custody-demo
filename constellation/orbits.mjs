// Real orbits for the constellation simulation.
//
// Satellites come from public two-line element sets (TLEs) and are propagated with SGP4
// (satellite.js). At every epoch:
//   - inter-satellite links are chosen from geometry: each satellite links to its nearest
//     neighbours within range whose line of sight clears the Earth and lower atmosphere,
//     with at most `maxIsl` links per satellite (existing links kept while they stay in
//     range and in sight, free terminals filled shortest first). Operators do not
//     publish their laser-link layouts, so this is a geometric model, not any operator's
//     actual topology;
//   - a ground station sees a satellite when it is above the elevation mask, and uses its
//     two highest satellites.
// The result plugs into sim.mjs as `c.topology(epoch)`.
import * as sat from "satellite.js";
import { genKeypair } from "../agent/lib/keys.mjs";
import { MOC } from "./sim.mjs";

const RE = 6378.137; // km
const C_KM_S = 299792.458;

// Public places spread across the continents; used only as ground-station locations.
export const STATIONS = [
  ["Fairbanks", 64.84, -147.72], ["Seattle", 47.61, -122.33], ["Los Angeles", 34.05, -118.24], ["Denver", 39.74, -104.99],
  ["Houston", 29.76, -95.37], ["Chicago", 41.88, -87.63], ["New York", 40.71, -74.01], ["Miami", 25.76, -80.19],
  ["Mexico City", 19.43, -99.13], ["Bogota", 4.71, -74.07], ["Lima", -12.05, -77.04], ["Santiago", -33.45, -70.67],
  ["Buenos Aires", -34.60, -58.38], ["Sao Paulo", -23.55, -46.63], ["Reykjavik", 64.15, -21.94], ["London", 51.51, -0.13],
  ["Madrid", 40.42, -3.70], ["Oslo", 59.91, 10.75], ["Berlin", 52.52, 13.40], ["Rome", 41.90, 12.50],
  ["Athens", 37.98, 23.73], ["Cairo", 30.04, 31.24], ["Lagos", 6.52, 3.38], ["Nairobi", -1.29, 36.82],
  ["Johannesburg", -26.20, 28.05], ["Dubai", 25.20, 55.27], ["Karachi", 24.86, 67.01], ["Mumbai", 19.08, 72.88],
  ["Bengaluru", 12.97, 77.59], ["Singapore", 1.35, 103.82], ["Jakarta", -6.21, 106.85], ["Manila", 14.60, 120.98],
  ["Seoul", 37.57, 126.98], ["Tokyo", 35.68, 139.69], ["Perth", -31.95, 115.86], ["Sydney", -33.87, 151.21],
  ["Auckland", -36.85, 174.76], ["Honolulu", 21.31, -157.86], ["Anchorage", 61.22, -149.90], ["Svalbard", 78.22, 15.65],
];

// Parse a CelesTrak-style three-line TLE file.
export function parseTles(text) {
  const lines = text.split(/\r?\n/).map((l) => l.trimEnd()).filter(Boolean);
  const out = [];
  for (let i = 0; i + 2 < lines.length + 1; i += 3) {
    if (!lines[i + 2] || !lines[i + 1].startsWith("1 ") || !lines[i + 2].startsWith("2 ")) continue;
    out.push({ name: lines[i].trim(), l1: lines[i + 1], l2: lines[i + 2] });
  }
  return out;
}

export function makeOrbitalConstellation({ tles, count = 4032, stations = STATIONS, startTime, stepSeconds = 60, maxIslKm = 2500, maxIsl = 4, elevationMaskDeg = 25, minAltKm = 450, maxAltKm = 650, keysFor } = {}) {
  const t0 = startTime ?? new Date();
  const recs = [];
  for (const t of tles) {
    const rec = sat.twoline2satrec(t.l1, t.l2);
    const pv = sat.propagate(rec, t0);
    if (!pv || !pv.position || typeof pv.position === "boolean") continue;
    const p = pv.position, alt = Math.hypot(p.x, p.y, p.z) - RE;
    if (alt < minAltKm || alt > maxAltKm) continue;
    recs.push({ name: t.name, rec, epochYear: rec.epochyr, epochDay: rec.epochdays });
    if (recs.length === count) break;
  }
  const sats = recs.map((r, i) => ({ eid: `ipn:${1000 + i}.0`, name: r.name, rec: r.rec }));
  const gs = stations.map(([name, lat, lon], g) => ({ eid: `ipn:${100 + g}.0`, name, gd: { latitude: sat.degreesToRadians(lat), longitude: sat.degreesToRadians(lon), height: 0.1 } }));
  const nodes = [...sats.map((x) => x.eid), ...gs.map((x) => x.eid), MOC];
  const keys = new Map(nodes.map((eid) => [eid, keysFor ? keysFor(eid) : genKeypair()]));
  const mask = sat.degreesToRadians(elevationMaskDeg);
  const cache = new Map();
  const stats = [];
  let prevEdges = null;

  function topology(e) {
    if (cache.has(e)) return cache.get(e);
    const when = new Date(t0.getTime() + e * stepSeconds * 1000);
    const gmst = sat.gstime(when);
    const n = sats.length;
    const pos = new Float64Array(n * 3);
    const ok = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
      const pv = sat.propagate(sats[i].rec, when);
      if (pv && pv.position && typeof pv.position !== "boolean") { pos[3 * i] = pv.position.x; pos[3 * i + 1] = pv.position.y; pos[3 * i + 2] = pv.position.z; ok[i] = 1; }
    }
    // Spatial hash for neighbour search.
    const cell = maxIslKm, grid = new Map();
    const key = (x, y, z) => `${Math.floor(x / cell)},${Math.floor(y / cell)},${Math.floor(z / cell)}`;
    for (let i = 0; i < n; i++) if (ok[i]) { const k = key(pos[3 * i], pos[3 * i + 1], pos[3 * i + 2]); (grid.get(k) || grid.set(k, []).get(k)).push(i); }
    const pairs = [];
    const clearsEarth = (i, j) => { // minimum distance of the segment from Earth's centre
      const ax = pos[3 * i], ay = pos[3 * i + 1], az = pos[3 * i + 2], dx = pos[3 * j] - ax, dy = pos[3 * j + 1] - ay, dz = pos[3 * j + 2] - az;
      const tt = Math.max(0, Math.min(1, -(ax * dx + ay * dy + az * dz) / (dx * dx + dy * dy + dz * dz)));
      return Math.hypot(ax + tt * dx, ay + tt * dy, az + tt * dz) > RE + 80;
    };
    for (let i = 0; i < n; i++) {
      if (!ok[i]) continue;
      const cx = Math.floor(pos[3 * i] / cell), cy = Math.floor(pos[3 * i + 1] / cell), cz = Math.floor(pos[3 * i + 2] / cell);
      for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) for (let d = -1; d <= 1; d++) {
        for (const j of grid.get(`${cx + a},${cy + b},${cz + d}`) || []) {
          if (j <= i) continue;
          const dist = Math.hypot(pos[3 * i] - pos[3 * j], pos[3 * i + 1] - pos[3 * j + 1], pos[3 * i + 2] - pos[3 * j + 2]);
          if (dist <= maxIslKm && clearsEarth(i, j)) pairs.push([dist, i, j]);
        }
      }
    }
    pairs.sort((x, y) => x[0] - y[0]);
    const deg = new Uint8Array(n), adj = Array.from({ length: n }, () => []);
    const edges = new Set();
    let islKm = 0;
    // Laser links stay locked while geometry allows: keep last epoch's links that are
    // still in range and in line of sight, then give free terminals to the nearest
    // remaining candidates.
    if (prevEdges) for (const [dist, i, j] of pairs) {
      if (!prevEdges.has(`${i}-${j}`) || deg[i] >= maxIsl || deg[j] >= maxIsl) continue;
      deg[i]++; deg[j]++; adj[i].push(j); adj[j].push(i); edges.add(`${i}-${j}`); islKm += dist;
    }
    for (const [dist, i, j] of pairs) {
      if (edges.has(`${i}-${j}`)) continue;
      if (deg[i] >= maxIsl || deg[j] >= maxIsl) continue;
      deg[i]++; deg[j]++; adj[i].push(j); adj[j].push(i); edges.add(`${i}-${j}`); islKm += dist;
    }
    // Ground-station visibility from real geometry.
    const sees = new Map();
    let stationsUp = 0, slantKm = 0, slantN = 0;
    for (const g of gs) {
      const cands = [];
      for (let i = 0; i < n; i++) {
        if (!ok[i]) continue;
        const ecf = sat.eciToEcf({ x: pos[3 * i], y: pos[3 * i + 1], z: pos[3 * i + 2] }, gmst);
        const look = sat.ecfToLookAngles(g.gd, ecf);
        if (look.elevation >= mask) cands.push([look.elevation, i, look.rangeSat]);
      }
      cands.sort((x, y) => y[0] - x[0]);
      const use = cands.slice(0, 2).filter(([, i]) => !sees.has(i));
      for (const [, i, range] of use) { sees.set(i, g.eid); slantKm += range; slantN++; }
      if (use.length) stationsUp++;
    }
    let added = 0, removed = 0;
    if (prevEdges) { for (const x of edges) if (!prevEdges.has(x)) added++; for (const x of prevEdges) if (!edges.has(x)) removed++; }
    prevEdges = edges;
    const s = { epoch: e, links: edges.size, added, removed, meanIslKm: edges.size ? islKm / edges.size : 0, meanIslMs: edges.size ? (islKm / edges.size / C_KM_S) * 1000 : 0, stationsUp, meanSlantKm: slantN ? slantKm / slantN : 0, isolated: [...deg].filter((x, i) => ok[i] && x === 0).length };
    stats.push(s);
    const topo = { adj, sees, stationsUp, crossLinksDown: 0 };
    cache.set(e, topo);
    return topo;
  }
  return { sats, gs, keys, nodes, seed: 7, planes: 0, perPlane: 0, topology, stats, startTime: t0, stepSeconds };
}
