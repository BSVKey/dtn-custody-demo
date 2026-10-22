// The network: five independent operators, their nodes, and which pairs can talk when.
// Contacts are computed from geometry (ephem.mjs) by sampling visibility, never typed in.
// Operator names are generic; the three deep-space stations sit at the real Goldstone,
// Madrid and Canberra coordinates. Rates are illustrative, of the right order.
import { moonPos, marsPos, stationPos, elevation, blocked, orbiter, farSide, marsSurface, lightMs, vec, R } from "./ephem.mjs";

export const OPERATORS = {
  ground:  { name: "Deep-space ground network", ratePerMB: 0.5 },
  lunaA:   { name: "Lunar relay operator A", ratePerMB: 2.0 },
  lunaB:   { name: "Lunar relay operator B (no custodian)", ratePerMB: 1.5 },
  marsnet: { name: "Mars relay operator", ratePerMB: 8.0 },
  science: { name: "Science mission (bundle owner)", ratePerMB: 0 },
};

const station = (lat, lon) => (t) => stationPos(t, { lat, lon });
const zero = () => [0, 0, 0];
const moonOrb = (radius, periodH, phase) => orbiter(moonPos, { radius, periodH, phase });

// kind: station | moc | lunar-orbiter | lunar-surface | mars-orbiter | mars-surface
export const NODES = {
  "ipn:1.0":  { name: "Mission operations", op: "science", kind: "moc", custodian: true, pos: zero },
  "ipn:10.0": { name: "Goldstone 70 m", op: "ground", kind: "station", custodian: true, pos: station(35.4267, -116.89) },
  "ipn:11.0": { name: "Madrid 70 m", op: "ground", kind: "station", custodian: true, pos: station(40.4314, -4.2481) },
  "ipn:12.0": { name: "Canberra 70 m", op: "ground", kind: "station", custodian: true, pos: station(-35.4014, 148.9817) },
  "ipn:20.0": { name: "Lunar relay A-1", op: "lunaA", kind: "lunar-orbiter", custodian: true, pos: moonOrb(R.MOON + 3000, 7.0, 0) },
  "ipn:21.0": { name: "Lunar relay A-2", op: "lunaA", kind: "lunar-orbiter", custodian: true, pos: moonOrb(R.MOON + 3000, 7.0, Math.PI) },
  "ipn:22.0": { name: "Operator A ground, Hawaii", op: "lunaA", kind: "station", custodian: true, pos: station(19.82, -155.47) },
  "ipn:30.0": { name: "Lunar relay B-1", op: "lunaB", kind: "lunar-orbiter", custodian: false, pos: moonOrb(R.MOON + 5000, 11.0, Math.PI / 2) },
  "ipn:40.0": { name: "Mars relay orbiter", op: "marsnet", kind: "mars-orbiter", custodian: true, pos: orbiter(marsPos, { radius: R.MARS + 300, periodH: 1.9 }) },
  "ipn:50.0": { name: "Far-side lander", op: "science", kind: "lunar-surface", custodian: true, pos: farSide(moonPos, R.MOON, { latDeg: -20 }) },
  "ipn:60.0": { name: "Mars rover", op: "science", kind: "mars-surface", custodian: true, pos: marsSurface({ latDeg: 18.4, lonDeg: 77.5 }) },
};

const MASK = 10; // degrees above the horizon for Earth stations and surface sites
const kbps = (x) => x * 1000, Mbps = (x) => x * 1e6;

// Can a see b at time t? Each kind of pair has its own rule; light time from the distance.
function visible(a, b, t) {
  const A = NODES[a], B = NODES[b], pa = A.pos(t), pb = B.pos(t);
  const clearOf = () => !blocked(pa, pb, [0, 0, 0], R.EARTH) && !blocked(pa, pb, moonPos(t), R.MOON) && !blocked(pa, pb, marsPos(t), R.MARS);
  const fromSurface = (n, p, q) => {
    if (n.kind === "station") return elevation(p, [0, 0, 0], q) > MASK;
    if (n.kind === "lunar-surface") return elevation(p, moonPos(t), q) > MASK;
    if (n.kind === "mars-surface") return elevation(p, marsPos(t), q) > MASK;
    return true;
  };
  return fromSurface(A, pa, pb) && fromSurface(B, pb, pa) && clearOf();
}

// Directed links: [from, to, bits per second]. Ground stations reach MOC by terrestrial network.
export const LINKS = [];
const both = (a, b, ab, ba) => { LINKS.push([a, b, ab]); LINKS.push([b, a, ba]); };
for (const s of ["ipn:10.0", "ipn:11.0", "ipn:12.0", "ipn:22.0"]) both("ipn:1.0", s, Mbps(100), Mbps(100));
for (const s of ["ipn:10.0", "ipn:11.0", "ipn:12.0"]) {
  both(s, "ipn:20.0", Mbps(2), Mbps(2)); both(s, "ipn:21.0", Mbps(2), Mbps(2)); both(s, "ipn:30.0", Mbps(1), Mbps(1));
  both(s, "ipn:40.0", kbps(8), Mbps(1));          // to the Mars orbiter: slow uplink, faster downlink
  both(s, "ipn:60.0", kbps(1), kbps(2));          // rover direct to Earth: very slow, both ways
}
both("ipn:22.0", "ipn:20.0", Mbps(2), Mbps(2)); both("ipn:22.0", "ipn:21.0", Mbps(2), Mbps(2));
for (const o of ["ipn:20.0", "ipn:21.0", "ipn:30.0"]) both(o, "ipn:50.0", kbps(500), kbps(500));
both("ipn:40.0", "ipn:60.0", Mbps(2), Mbps(2));

const TERRESTRIAL = (a, b) => NODES[a].kind === "moc" || NODES[b].kind === "moc";

// Contact windows over [start, start + hours): { id, from, to, start, end, rateBps, owltMs }.
// Light time is the distance at the window's midpoint, rounded to the millisecond.
export function computeContacts(start, hours, stepS = 60) {
  const out = [];
  const step = stepS * 1000, end = start + hours * 3.6e6;
  for (const [a, b, rate] of LINKS) {
    if (TERRESTRIAL(a, b)) { out.push({ from: a, to: b, start, end, rateBps: rate, owltMs: 50 }); continue; }
    let open = null;
    for (let t = start; t <= end; t += step) {
      const on = t < end && visible(a, b, t);
      if (on && open === null) open = t;
      if (!on && open !== null) {
        const mid = (open + t) / 2;
        out.push({ from: a, to: b, start: open, end: t, rateBps: rate, owltMs: Math.round(lightMs(vec.len(vec.sub(NODES[a].pos(mid), NODES[b].pos(mid))))) });
        open = null;
      }
    }
  }
  out.sort((x, y) => x.start - y.start || x.from.localeCompare(y.from));
  out.forEach((c, i) => { c.id = `c${i}`; });
  return out;
}

// One contact plan per operator, in this repo's format (contact-plans/), covering the links
// that operator transmits on. Times in seconds from `start`.
export function operatorPlans(contacts, start) {
  const plans = {};
  for (const op of Object.keys(OPERATORS)) {
    const mine = contacts.filter((c) => NODES[c.from].op === op);
    const ids = [...new Set(mine.map((c) => `${c.from}>${c.to}`))];
    const ipn = (eid) => Number(eid.split(":")[1].split(".")[0]);
    plans[op] = {
      name: `ssi-${op}`, epoch: new Date(start).toISOString(),
      nodes: [...new Set(mine.flatMap((c) => [c.from, c.to]))].map((e) => ({ ipn: ipn(e), name: NODES[e].name })),
      links: ids.map((id) => { const [f, t] = id.split(">"); return { id, from: ipn(f), to: ipn(t) }; }),
      delays: Object.fromEntries(ids.map((id) => {
        const c = mine.find((x) => `${x.from}>${x.to}` === id);
        return [id, { one_way_ms: c.owltMs, rate_bps: c.rateBps }];
      })),
      contacts: mine.map((c) => ({ link: `${c.from}>${c.to}`, up_s: Math.round((c.start - start) / 1000), down_s: Math.round((c.end - start) / 1000), owlt_ms: c.owltMs })),
    };
  }
  return plans;
}
