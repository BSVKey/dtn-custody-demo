// Bit error sweep: both Voyagers at several post-decoding bit error rates, 20 seeds each,
// and two science-frame chunk sizes at the worst rate. Prints a markdown table of what lost
// bundles cost when a resend request has to cross a light time (and, for Voyager 2, wait
// for DSS-43). A run whose resends run past the 30-day signed plan counts as not done.
// node voyager/sweep.mjs
import { runMission } from "./mission.mjs";

const CASES = [[0, 1024], [1e-6, 1024], [1e-5, 1024], [1e-4, 1024], [1e-4, 256]];
const SEEDS = Array.from({ length: 20 }, (_, i) => i + 1);
const median = (xs) => { const s = [...xs].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; };
const fmt = (xs) => (xs.length ? `${median(xs).toFixed(1)} / ${Math.max(...xs).toFixed(1)}` : "none");

console.log("| Mission | Bit error rate | Science chunk | Science transmissions lost (mean, of bundles) | Science frame, hours to last chunk (median / worst) | Command confirmed at JPL, hours (median / worst) | Done within the 30-day plan, all verified |");
console.log("|---|---|---|---|---|---|---|");
for (const key of ["voyager1", "voyager2"]) {
  for (const [ber, chunk] of CASES) {
    const rs = [], notDone = [];
    for (const seed of ber ? SEEDS : [1]) {
      try { rs.push(runMission(key, { ber, seed, downChunk: chunk })); } catch (e) { notDone.push(e.message); }
    }
    const n = rs.length + notDone.length;
    const lost = rs.length ? (rs.reduce((a, r) => a + r.downlink.lostAndResent, 0) / rs.length).toFixed(1) + ` of ${rs[0].downlink.bundles}` : "-";
    const verified = rs.filter((r) => r.ok).length;
    console.log(`| ${key === "voyager1" ? "Voyager 1" : "Voyager 2"} | ${ber || "0"} | ${chunk} B | ${lost} | ${fmt(rs.map((r) => r.downlink.hoursToLast))} | ${fmt(rs.map((r) => r.uplink.readyToConfirmedH))} | ${verified} of ${n} |`);
  }
}
