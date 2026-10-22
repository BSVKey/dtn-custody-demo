// Mars solar conjunction: every 26 months Mars passes behind the Sun as seen from Earth, and
// for two weeks or more no mission can reach it (the Sun's noise swamps the link). Missions stop
// commanding and store their data until it is over. A relay at Sun-Earth L5, 60 degrees behind
// Earth on its orbit, sees Mars well away from the Sun the whole time: this world asks what
// that relay changes, with contacts computed from geometry (ssi/ephem.mjs).
//
// Rates are illustrative, of the right order, and fall with the square of the distance
// (fixed antennas and power): RATE_AT_1AU at 1 AU.
import { marsPos, sunPos, stationPos, elevation, blocked, orbiter, marsSurface, sunEarthLagrange, lightMs, vec, R } from "../ephem.mjs";

export const AU = 149597870.7;
export const OPERATORS = {
  ground:  { name: "Deep-space ground network", ratePerMB: 0.5 },
  marsnet: { name: "Mars relay operator", ratePerMB: 8.0 },
  helio:   { name: "Heliocentric relay operator (Sun-Earth L5)", ratePerMB: 12.0 },
  science: { name: "Mars mission (bundle owner)", ratePerMB: 0 },
};

const station = (lat, lon) => (t) => stationPos(t, { lat, lon });
export const NODES = {
  "ipn:1.0":  { name: "Mission operations", op: "science", kind: "moc", custodian: true, pos: () => [0, 0, 0] },
  "ipn:10.0": { name: "Goldstone 70 m", op: "ground", kind: "station", custodian: true, pos: station(35.4267, -116.89) },
  "ipn:11.0": { name: "Madrid 70 m", op: "ground", kind: "station", custodian: true, pos: station(40.4314, -4.2481) },
  "ipn:12.0": { name: "Canberra 70 m", op: "ground", kind: "station", custodian: true, pos: station(-35.4014, 148.9817) },
  "ipn:40.0": { name: "Mars relay orbiter", op: "marsnet", kind: "mars-orbiter", custodian: true, pos: orbiter(marsPos, { radius: R.MARS + 300, periodH: 1.9 }) },
  "ipn:60.0": { name: "Mars rover", op: "science", kind: "mars-surface", custodian: true, pos: marsSurface({ latDeg: 18.4, lonDeg: 77.5 }) },
  "ipn:70.0": { name: "L5 relay", op: "helio", kind: "helio-relay", custodian: true, pos: (t) => sunEarthLagrange(t, -60) },
};

const MASK = 10; // degrees above the horizon, Earth stations and the rover
const kbps = (x) => x * 1000, Mbps = (x) => x * 1e6;

// [a, b, rate a->b at 1 AU, rate b->a at 1 AU]; Earth-Mars rates are of the order of today's
// Mars orbiters, the rover's direct-to-Earth link is slow, the L5 relay has a large antenna.
const PAIRS = [];
for (const s of ["ipn:10.0", "ipn:11.0", "ipn:12.0"]) {
  PAIRS.push(["ipn:1.0", s, Mbps(100), Mbps(100)]);
  PAIRS.push([s, "ipn:40.0", kbps(32), Mbps(4)]);
  PAIRS.push([s, "ipn:60.0", kbps(2), kbps(4)]);
  PAIRS.push([s, "ipn:70.0", kbps(256), Mbps(8)]);
}
PAIRS.push(["ipn:40.0", "ipn:60.0", Mbps(2), Mbps(2)]);
PAIRS.push(["ipn:70.0", "ipn:40.0", kbps(256), Mbps(4)]);

// Can a and b talk at t? The Sun closes a link when the radio path passes through the inner
// corona: closer to the Sun than 1 AU x sin(sepDeg). For a link from Earth that is the usual
// Sun-Earth-probe angle limit; the same physics then applies to the L5-Mars path.
export const coronaKm = (sepDeg) => AU * Math.sin((sepDeg * Math.PI) / 180);
function visible(a, b, t, sepDeg) {
  const A = NODES[a], B = NODES[b], pa = A.pos(t), pb = B.pos(t), mars = marsPos(t);
  if (A.kind === "moc") return true;
  if (blocked(pa, pb, sunPos(t), coronaKm(sepDeg))) return false;
  if (blocked(pa, pb, [0, 0, 0], R.EARTH) || blocked(pa, pb, mars, R.MARS)) return false;
  for (const [N, p, q] of [[A, pa, pb], [B, pb, pa]]) {
    if (N.kind === "station" && elevation(p, [0, 0, 0], q) < MASK) return false;
    if (N.kind === "mars-surface" && elevation(p, mars, q) < MASK) return false;
  }
  return true;
}

// Contact windows over [start, start + days): { id, from, to, start, end, rateBps, owltMs }, both
// directions of each pair. relay: include the L5 relay. sepDeg: the Sun exclusion angle.
export function computeContacts(start, days, { relay = true, sepDeg = 2, stepS = 120 } = {}) {
  const out = [], step = stepS * 1000, end = start + days * 864e5;
  for (const [a, b, ab, ba] of PAIRS) {
    if (!relay && (a === "ipn:70.0" || b === "ipn:70.0")) continue;
    if (NODES[a].kind === "moc") {
      out.push({ from: a, to: b, start, end, rateBps: ab, owltMs: 50 }, { from: b, to: a, start, end, rateBps: ba, owltMs: 50 });
      continue;
    }
    let open = null;
    for (let t = start; t <= end; t += step) {
      const on = t < end && visible(a, b, t, sepDeg);
      if (on && open === null) open = t;
      if (!on && open !== null) {
        const mid = (open + t) / 2, km = vec.len(vec.sub(NODES[a].pos(mid), NODES[b].pos(mid)));
        const scale = Math.min(1, (AU / km) ** 2), owltMs = Math.round(lightMs(km));
        out.push({ from: a, to: b, start: open, end: t, rateBps: Math.round(ab * scale), owltMs });
        out.push({ from: b, to: a, start: open, end: t, rateBps: Math.round(ba * scale), owltMs });
        open = null;
      }
    }
  }
  out.sort((x, y) => x.start - y.start || x.from.localeCompare(y.from));
  out.forEach((c, i) => { c.id = `c${i}`; });
  return out;
}

export const nodesFor = (relay) => Object.fromEntries(Object.entries(NODES).filter(([e]) => relay || e !== "ipn:70.0"));
