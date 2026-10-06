// Ground-station passes from real orbits, as a contact plan the compiler (compile.mjs) and the
// simulator accept.
//
// Satellites come from two-line element sets (TLEs) and are propagated with SGP4
// (satellite.js). A satellite and a ground station are in contact while the satellite is above
// the station's elevation mask. Each contact becomes two one-way links (satellite to station and
// station to satellite), with the one-way light time taken from the slant range at the middle
// of the pass. Times in the plan are seconds from `startMs`, which is kept as the plan's epoch
// so absolute times (Hardy) can be produced.
import * as sat from "satellite.js";

const C_KM_S = 299792.458;
const RAD = Math.PI / 180;

// CelesTrak-style TLE text: name line, line 1, line 2 (the name line is optional).
export function parseTles(text) {
  const lines = String(text).split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].startsWith("1 ") && lines[i + 1]?.startsWith("2 ")) {
      const name = i > 0 && !lines[i - 1].startsWith("1 ") && !lines[i - 1].startsWith("2 ") ? lines[i - 1] : `NORAD ${lines[i].slice(2, 7).trim()}`;
      out.push({ name, line1: lines[i], line2: lines[i + 1] });
      i++;
    }
  }
  return out;
}

// Look angles from a station to a satellite at a time; null when SGP4 cannot propagate.
function look(satrec, gd, date) {
  const pv = sat.propagate(satrec, date);
  if (!pv || !pv.position || typeof pv.position === "boolean") return null;
  const ecf = sat.eciToEcf(pv.position, sat.gstime(date));
  const la = sat.ecfToLookAngles(gd, ecf);
  return { elevDeg: la.elevation / RAD, rangeKm: la.rangeSat };
}

// Passes of each satellite over each station in [startMs, startMs + hours).
//   stations: [{ name, lat, lon, altKm? }]   elevationMaskDeg default 10, stepS default 30
// Pass edges are refined to the second by bisection between steps.
export function computePasses({ tles, stations, startMs, hours = 24, elevationMaskDeg = 10, stepS = 30 }) {
  if (!tles.length || !stations.length) throw new Error("need at least one satellite and one station");
  if (!(hours > 0 && hours <= 168)) throw new Error("the window can be up to 7 days (168 hours)");
  const endMs = startMs + hours * 3600000;
  const passes = [];
  for (const t of tles) {
    const satrec = sat.twoline2satrec(t.line1, t.line2);
    for (const s of stations) {
      const gd = { latitude: s.lat * RAD, longitude: s.lon * RAD, height: s.altKm ?? 0 };
      const up = (ms) => { const l = look(satrec, gd, new Date(ms)); return l && l.elevDeg >= elevationMaskDeg; };
      const edge = (lo, hi, rising) => { // first second where visibility flips, between lo (old) and hi (new)
        while (hi - lo > 1000) { const mid = Math.floor((lo + hi) / 2000) * 1000; if (up(mid) === rising) hi = mid; else lo = mid; }
        return hi;
      };
      let prevMs = startMs, prevUp = up(startMs), aos = prevUp ? startMs : null;
      for (let ms = startMs + stepS * 1000; ms <= endMs; ms += stepS * 1000) {
        const nowUp = up(ms);
        if (nowUp && !prevUp) aos = edge(prevMs, ms, true);
        if (!nowUp && prevUp) { push(edge(prevMs, ms, false)); aos = null; }
        prevMs = ms; prevUp = nowUp;
      }
      if (aos !== null) push(endMs);
      function push(los) {
        if (los - aos < 1000) return;
        const mid = look(satrec, gd, new Date((aos + los) / 2));
        let maxEl = -90;
        for (let ms = aos; ms <= los; ms += 15000) { const l = look(satrec, gd, new Date(ms)); if (l && l.elevDeg > maxEl) maxEl = l.elevDeg; }
        passes.push({ satellite: t.name, station: s.name, aosMs: aos, losMs: los, maxElevationDeg: Math.round(maxEl * 10) / 10, midRangeKm: Math.round(mid?.rangeKm ?? 0) });
      }
    }
  }
  return passes.sort((a, b) => a.aosMs - b.aosMs);
}

// A contact plan from passes. Satellites get ipn node numbers from satIpnStart, stations from
// stationIpnStart, in the order given.
export function passesToPlan(passes, { name = "ground-passes", description, startMs, tles, stations, rateBps = 1000000, satIpnStart = 100, stationIpnStart = 10 }) {
  const satIpn = new Map(tles.map((t, i) => [t.name, satIpnStart + i]));
  const gsIpn = new Map(stations.map((s, i) => [s.name, stationIpnStart + i]));
  const nodes = [...[...satIpn].map(([n, ipn]) => ({ ipn, name: n })), ...[...gsIpn].map(([n, ipn]) => ({ ipn, name: n }))];
  const links = [], delays = {}, contacts = [];
  passes.forEach((p, i) => {
    const s = satIpn.get(p.satellite), g = gsIpn.get(p.station);
    const one_way_ms = Math.max(1, Math.round((p.midRangeKm / C_KM_S) * 1000));
    const up_s = Math.round((p.aosMs - startMs) / 1000), down_s = Math.round((p.losMs - startMs) / 1000);
    if (!(down_s > up_s)) return;
    for (const [dir, from, to] of [["d", s, g], ["u", g, s]]) {
      const id = `P${i + 1}${dir}`;
      links.push({ id, from, to });
      delays[id] = { one_way_ms, loss_pct: 0, reorder_pct: 0, rate_bps: rateBps };
      contacts.push({ link: id, up_s, down_s, note: `${p.satellite} ${dir === "d" ? "to" : "from"} ${p.station}, max elevation ${p.maxElevationDeg} deg` });
    }
  });
  return {
    name, description: description || `${passes.length} ground passes computed with SGP4 from the TLEs supplied, starting ${new Date(startMs).toISOString()}.`,
    scale: 1, epoch: new Date(startMs).toISOString(), nodes, links, delays, contacts,
  };
}
