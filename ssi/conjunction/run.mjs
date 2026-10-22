// Mars through solar conjunction (March 2028), with and without a relay at Sun-Earth L5.
// Real BPv7 bundles, contact graph routing, custody receipts v2 and clearing (ssi/network.mjs,
// ssi/settle.mjs) over contacts computed from geometry (world.mjs).
//   node ssi/conjunction/run.mjs [--sep 2] [--write]   (--write: RESULTS-data.json and figures)
import { writeFileSync } from "node:fs";
import { decodeBundle } from "../../transport/bpv7/bundle.mjs";
import { bundleIdentity } from "../../transport/bpv7/receipt-v2.mjs";
import { verifyRecord } from "../../agent/lib/receipt.mjs";
import { provision, runNetwork, dtn } from "../network.mjs";
import { clear } from "../settle.mjs";
import { marsPos, sunPos, sunEarthLagrange, vec } from "../ephem.mjs";
import { NODES, OPERATORS, AU, computeContacts, nodesFor, coronaKm } from "./world.mjs";

const H = 3.6e6, D = 864e5;
const START = Date.parse("2028-02-15T00:00:00Z"), DAYS = 75;
const TRAFFIC_FROM = Date.parse("2028-02-20T00:00:00Z"), TRAFFIC_DAYS = 60;
const MARS_SIDE = new Set(["ipn:40.0", "ipn:60.0"]);
const iso = (t) => new Date(t).toISOString().slice(0, 16).replace("T", " ");

// The Earth-Mars blackout: the longest gap in Mars orbiter -> Earth station contacts.
export function blackout(contacts) {
  const em = contacts.filter((c) => c.from === "ipn:40.0" && NODES[c.to].kind === "station").sort((a, b) => a.start - b.start);
  let g = { from: 0, to: 0 };
  for (let i = 1; i < em.length; i++) if (em[i].start - em[i - 1].end > g.to - g.from) g = { from: em[i - 1].end, to: em[i].start };
  return { ...g, days: (g.to - g.from) / D };
}

export function traffic() {
  const out = []; let n = 0;
  for (let h = 3; h < TRAFFIC_DAYS * 24; h += 6) out.push({ src: "ipn:60.0", dst: "ipn:1.0", bytes: 100000, created: TRAFFIC_FROM + h * H, label: `rover-img-${++n}`, lifetimeDays: 45 });
  for (let h = 9; h < TRAFFIC_DAYS * 24; h += 12) out.push({ src: "ipn:1.0", dst: "ipn:60.0", bytes: 2000, created: TRAFFIC_FROM + h * H, label: `cmd-rover-${++n}`, lifetimeDays: 45 });
  return out;
}

export function scenario({ relay, sepDeg = 2 }) {
  const nodes = nodesFor(relay), operators = Object.fromEntries(Object.entries(OPERATORS).filter(([k]) => relay || k !== "helio"));
  const contacts = computeContacts(START, DAYS, { relay, sepDeg });
  const keys = provision(START, { nodes, operators, keyDays: 120 });
  const tr = traffic();
  const net = runNetwork({ start: START, contacts, keys, traffic: tr, nodes });
  const out = blackout(contacts);

  // Flows: delivery and latency, overall and for bundles created during the blackout.
  const flows = {};
  for (const t of tr) { const k = t.label.replace(/-\d+$/, ""); flows[k] ??= { sent: 0, delivered: 0, lat: [], latOut: [], sentOut: 0, viaL5: 0 }; flows[k].sent++; if (t.created >= out.from && t.created < out.to) flows[k].sentOut++; }
  for (const d of net.deliveries) {
    const f = flows[d.label.replace(/-\d+$/, "")], h = (d.deliveredAt - d.created) / H;
    f.delivered++; f.lat.push(h);
    if (d.created >= out.from && d.created < out.to) f.latOut.push(h);
    if (d.path.some((p) => p.node === "ipn:70.0")) f.viaL5++;
  }
  const stat = (a) => { const s = [...a].sort((x, y) => x - y); return s.length ? { median: +s[Math.floor(s.length / 2)].toFixed(1), max: +s.at(-1).toFixed(1) } : null; };
  for (const f of Object.values(flows)) { f.latencyH = stat(f.lat); f.blackoutLatencyH = stat(f.latOut); delete f.lat; delete f.latOut; }

  // Data waiting on the Mars side (rover and orbiter stores), its high-water mark.
  const ev = [];
  for (const b of [...net.deliveries, ...net.undelivered]) for (const p of b.path) if (MARS_SIDE.has(p.node)) {
    ev.push([p.arrive, b.bytes0], [p.depart ?? (b.deliveredAt ?? START + DAYS * D), -b.bytes0]);
  }
  ev.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  let held = 0, peak = { bytes: 0, at: 0 };
  for (const [t, d] of ev) { held += d; if (held > peak.bytes) peak = { bytes: held, at: t }; }

  // Receipts at the destination, and clearing between operators from them.
  const verified = net.deliveries.filter((d) => d.atDest?.ok).length;
  const delivered = new Set(net.deliveries.map((d) => JSON.stringify(bundleIdentity(decodeBundle(d.data)))));
  const claims = net.deliveries.filter((d) => d.dst === "ipn:1.0").map((d) => ({ data: d.data, arrivedAt: dtn(d.deliveredAt), source: "delivery", note: d.id }));
  const period = { from: new Date(START).toISOString(), to: new Date(START + DAYS * D).toISOString() };
  const clearing = clear({ claims, keyring: net.rings["ipn:1.0"], delivered, clearingKey: keys.nodeKeys["ipn:1.0"], period, operators, opOf: (eid) => nodes[eid]?.op });
  const pay = Object.fromEntries(Object.entries(clearing.perOp).filter(([, s]) => s.bundles).map(([op, s]) => [op, { bundles: s.bundles, megabytes: +(s.bytes / 1e6).toFixed(2), amount: +s.amount.toFixed(2), rejected: s.rejected }]));
  const statementsVerify = Object.values(clearing.statements).every((r) => verifyRecord(r, keys.nodeKeys["ipn:1.0"].pub).ok);

  return {
    relay, sepDeg, contacts: contacts.length, blackout: { from: iso(out.from), to: iso(out.to), days: +out.days.toFixed(1) },
    flows, undelivered: net.undelivered.length, marsStorePeak: { megabytes: +(peak.bytes / 1e6).toFixed(1), at: iso(peak.at) },
    receipts: { delivered: net.deliveries.length, verifiedAtDestination: verified }, settlement: pay, rejectedClaims: clearing.rejected.length, statementsVerify,
    _deliveries: net.deliveries.filter((d) => d.label.startsWith("rover-img")).map((d) => [d.created, (d.deliveredAt - d.created) / H]), _out: out,
  };
}

// ---- Figures ------------------------------------------------------------------------------------
function geometrySvg(t, sepDeg) {
  // Heliocentric, ecliptic-ish top view (equatorial x-y of geocentric vectors shifted to the Sun).
  const S = sunPos(t), P = (g) => vec.sub(g, S), E = P([0, 0, 0]), M = P(marsPos(t)), L5 = P(sunEarthLagrange(t, -60)), L4 = P(sunEarthLagrange(t, 60));
  const k = 170 / (1.6 * AU), cx = 230, cy = 210, xy = (p) => [cx + p[0] * k, cy - p[1] * k];
  const dot = (p, r, fill, label, dx = 8, dy = -8) => { const [x, y] = xy(p); return `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${r}" fill="${fill}"/><text x="${(x + dx).toFixed(1)}" y="${(y + dy).toFixed(1)}" font-size="12" fill="#ddd">${label}</text>`; };
  const line = (a, b, color, dash = "") => { const [x1, y1] = xy(a), [x2, y2] = xy(b); return `<line x1="${x1.toFixed(1)}" y1="${y1.toFixed(1)}" x2="${x2.toFixed(1)}" y2="${y2.toFixed(1)}" stroke="${color}" stroke-width="1.6" ${dash ? `stroke-dasharray="${dash}"` : ""}/>`; };
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 460 440" font-family="sans-serif">
<rect width="460" height="440" fill="#0b0f19"/>
<circle cx="${cx}" cy="${cy}" r="${(AU * k).toFixed(1)}" fill="none" stroke="#2b3550"/>
<circle cx="${cx}" cy="${cy}" r="${(1.524 * AU * k).toFixed(1)}" fill="none" stroke="#2b3550"/>
<circle cx="${cx}" cy="${cy}" r="${Math.max(6, coronaKm(sepDeg) * k).toFixed(1)}" fill="#ffb02033" stroke="#ffb020" stroke-dasharray="3 3"/>
${line(E, M, "#e5484d", "5 4")}${line(E, L5, "#3dd68c")}${line(L5, M, "#3dd68c")}
<circle cx="${cx}" cy="${cy}" r="5" fill="#ffd34d"/>
${dot(E, 5, "#4c9aff", "Earth")}${dot(M, 5, "#ff7a45", "Mars")}${dot(L5, 4, "#3dd68c", "L5 relay")}${dot(L4, 3, "#556", "L4", 6, 14)}
<text x="16" y="24" font-size="14" fill="#fff">Mars solar conjunction, ${new Date(t).toISOString().slice(0, 10)}</text>
<text x="16" y="398" font-size="11" fill="#e5484d">red: Earth to Mars, through the corona: closed</text>
<text x="16" y="413" font-size="11" fill="#3dd68c">green: Earth to the L5 relay to Mars: open</text>
<text x="16" y="428" font-size="11" fill="#aab">corona limit (${sepDeg} deg from 1 AU) drawn to scale, hidden by the Sun</text>
</svg>`;
}

function latencySvg(a, b, out) {
  const W = 640, Hh = 300, l = 52, r = 16, top = 30, bot = 40;
  const t0 = TRAFFIC_FROM, t1 = TRAFFIC_FROM + TRAFFIC_DAYS * D, ymax = 24 * 5 * Math.ceil(Math.max(24, ...a._deliveries.map((d) => d[1]), ...b._deliveries.map((d) => d[1])) / (24 * 5));
  const X = (t) => l + ((t - t0) / (t1 - t0)) * (W - l - r), Y = (h) => top + (1 - h / ymax) * (Hh - top - bot);
  const pts = (s, color) => s._deliveries.map(([t, h]) => `<circle cx="${X(t).toFixed(1)}" cy="${Y(h).toFixed(1)}" r="2" fill="${color}"/>`).join("");
  const ticks = Array.from({ length: ymax / 120 + 1 }, (_, i) => i / (ymax / 120)).map((f) => { const h = f * ymax; return `<line x1="${l}" x2="${W - r}" y1="${Y(h).toFixed(1)}" y2="${Y(h).toFixed(1)}" stroke="#222a3a"/><text x="${l - 6}" y="${(Y(h) + 4).toFixed(1)}" font-size="10" fill="#aab" text-anchor="end">${Math.round(h / 24)} d</text>`; }).join("");
  const days = []; for (let t = t0; t <= t1; t += 10 * D) days.push(`<text x="${X(t).toFixed(1)}" y="${Hh - bot + 16}" font-size="10" fill="#aab" text-anchor="middle">${new Date(t).toISOString().slice(5, 10)}</text>`);
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${Hh}" font-family="sans-serif">
<rect width="${W}" height="${Hh}" fill="#0b0f19"/>
<rect x="${X(out.from).toFixed(1)}" y="${top}" width="${(X(out.to) - X(out.from)).toFixed(1)}" height="${Hh - top - bot}" fill="#ffb02022"/>
${ticks}${days.join("")}${pts(a, "#e5484d")}${pts(b, "#3dd68c")}
<text x="${l}" y="20" font-size="13" fill="#fff">Rover image latency (created to delivered at mission operations), 2028</text>
<text x="${W - r}" y="20" font-size="11" fill="#e5484d" text-anchor="end">no relay</text><text x="${W - r - 60}" y="20" font-size="11" fill="#3dd68c" text-anchor="end">via L5</text>
<text x="${(X(out.from) + 4).toFixed(1)}" y="${top + 14}" font-size="10" fill="#ffb020">Earth-Mars blackout</text>
</svg>`;
}

if (import.meta.url === `file://${process.argv[1].replace(/\\/g, "/").replace(/^([A-Za-z]):/, "/$1:")}` || process.argv[1]?.endsWith("run.mjs")) {
  const sepI = process.argv.indexOf("--sep"), sepDeg = sepI > 0 ? Number(process.argv[sepI + 1]) : 2;
  const a = scenario({ relay: false, sepDeg }), b = scenario({ relay: true, sepDeg });
  const strip = ({ _deliveries, _out, ...x }) => x;
  const sweep = [1, 2, 3, 5].map((s) => ({ sepDeg: s, earthMarsBlackoutDays: +blackout(computeContacts(START, DAYS, { relay: false, sepDeg: s })).days.toFixed(1) }));
  const result = { conjunction: "2028-03-21", window: { from: iso(START), days: DAYS }, noRelay: strip(a), withL5Relay: strip(b), blackoutBySunLimit: sweep };
  console.log(JSON.stringify(result, null, 1));
  if (process.argv.includes("--write")) {
    const dir = new URL(".", import.meta.url);
    writeFileSync(new URL("RESULTS-data.json", dir), JSON.stringify(result, null, 1) + "\n");
    writeFileSync(new URL("geometry.svg", dir), geometrySvg(Date.parse("2028-03-21T00:00:00Z"), sepDeg));
    writeFileSync(new URL("latency.svg", dir), latencySvg(a, b, a._out));
    console.error("wrote ssi/conjunction/RESULTS-data.json, geometry.svg, latency.svg");
  }
}
