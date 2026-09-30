#!/usr/bin/env node
// Custody over real orbits: public Starlink TLEs propagated with SGP4, links and ground
// visibility from geometry each minute, traffic routed hop by hop, every bundle verified.
//   node constellation/orbits-run.mjs            4,032 satellites, 10,000 bundles, 40 minutes
//   node constellation/orbits-run.mjs --write    also write constellation/ORBITS-RESULTS.md
// Orbital elements are fetched from CelesTrak (public) into constellation/.tle-cache/ and not
// redistributed; the results record exactly which snapshot was used.
import { readFileSync, writeFileSync, existsSync, mkdirSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import os from "node:os";
import { genKeypair } from "../agent/lib/keys.mjs";
import { signRecord } from "../agent/lib/receipt.mjs";
import { pinnedDirectory } from "../agent/lib/path.mjs";
import { simulate, verifyAll } from "./sim.mjs";
import { parseTles, makeOrbitalConstellation } from "./orbits.mjs";

const SRC = "https://celestrak.org/NORAD/elements/gp.php?GROUP=starlink&FORMAT=tle";
const cacheDir = new URL("./.tle-cache/", import.meta.url), cacheFile = new URL("starlink.tle", cacheDir);
if (!existsSync(cacheFile) || process.argv.includes("--refresh")) {
  mkdirSync(cacheDir, { recursive: true });
  const r = await fetch(SRC, { headers: { "user-agent": "dtn-custody-demo (support@embryospace.com)" } });
  if (!r.ok) throw new Error(`CelesTrak fetch failed: ${r.status}`);
  writeFileSync(cacheFile, await r.text());
}
const raw = readFileSync(cacheFile, "utf8");
const tles = parseTles(raw);
const fetched = statSync(cacheFile).mtime;
const fmt = (n) => Math.round(n).toLocaleString("en-US");
const secs = (t) => `${((performance.now() - t) / 1000).toFixed(1)} s`;

const startTime = new Date(Math.floor(fetched.getTime() / 60000) * 60000);
const count = Number(process.argv.find((a) => a.startsWith("--count="))?.slice(8) || 4032);
const cfg = { bundles: Number(process.argv.find((a) => a.startsWith("--bundles="))?.slice(10) || 10000), epochs: 40, ticksPerEpoch: 10 };
let t = performance.now();
const c = makeOrbitalConstellation({ tles, count, startTime });
const tBuild = secs(t);
t = performance.now();
const run = simulate(c, cfg);
const tSim = secs(t);
t = performance.now();
const base = verifyAll(c, run);
const tVerify = secs(t);

// Attacks: a rogue key over a satellite's batch, and a satellite revoked as compromised.
const delivered = new Set(run.delivered.map((d) => d.bundleId));
const isSat = (eid) => Number(eid.slice(4, eid.indexOf("."))) >= 1000;
const i = run.batches.findIndex((b) => isSat(b.receipt.thisHop) && b.leaves.some((id) => delivered.has(id)));
const forged = { ...run, batches: run.batches.map((b, k) => { if (k !== i) return b; const { claimId, sig, signerPub, ...content } = b.receipt; return { ...b, receipt: signRecord(genKeypair(), content) }; }) };
const rogue = verifyAll(c, forged);
const rogueExpected = run.batches[i].leaves.filter((id) => delivered.has(id)).length;
const busy = new Map();
for (const b of run.batches) if (isSat(b.receipt.thisHop)) busy.set(b.receipt.thisHop, (busy.get(b.receipt.thisHop) || 0) + b.leaves.length);
const victim = [...busy.entries()].sort((a, b) => b[1] - a[1])[0][0];
const since = run.batches.filter((b) => b.receipt.thisHop === victim).map((b) => b.receipt.from).sort((a, b) => a - b)[1];
const dir = pinnedDirectory(new Map([...c.keys].map(([eid, kp]) => [eid, kp.pub])));
const comp = verifyAll(c, run, { authorize: (pub, eid, at) => (eid === victim && at >= since ? { ok: false, reason: "key_compromised" } : dir(pub, eid, at)) });
const compExpected = new Set(run.batches.filter((b) => b.receipt.thisHop === victim && b.receipt.from >= since).flatMap((b) => b.leaves).filter((id) => delivered.has(id))).size;

const st = c.stats;
const avg = (f) => st.reduce((a, s) => a + f(s), 0) / st.length;
const churn = st.slice(1).reduce((a, s) => a + s.added + s.removed, 0);
const epochs = tles.map((x) => { const yy = Number(x.l1.slice(18, 20)), day = Number(x.l1.slice(20, 32)); return Date.UTC(2000 + yy, 0, 1) + (day - 1) * 86400000; });
const iso = (ms) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");
const ok = base.failed === 0 && run.stranded.length === 0 && rogue.failed === rogueExpected && rogue.failures.signer_not_authorized === rogueExpected && comp.failed === compExpected && comp.failures.key_compromised === compExpected;

const lines = [
  `# Custody over real orbits: ${fmt(c.sats.length)} Starlink satellites`, "",
  `Run ${new Date().toISOString().slice(0, 10)} on ${os.cpus()[0].model.trim()}, Node ${process.version}, one thread. Reproduce: \`node constellation/orbits-run.mjs\` (fetches current elements).`, "",
  "## Orbital data", "",
  "| | |", "|---|---|",
  `| Source | CelesTrak public GP data, Starlink group (${SRC}) |`,
  `| Snapshot | ${fmt(tles.length)} element sets, fetched ${iso(fetched.getTime())}, sha256 ${createHash("sha256").update(raw).digest("hex").slice(0, 16)}... |`,
  `| Element epochs | ${iso(Math.min(...epochs))} to ${iso(Math.max(...epochs))} |`,
  `| Used | the first ${fmt(c.sats.length)} satellites between 450 and 650 km altitude at the start time |`,
  `| Propagation | SGP4 (satellite.js), every ${c.stepSeconds} s from ${iso(startTime.getTime())} for ${cfg.epochs} minutes |`,
  `| Build | ${tBuild} |`, "",
  "## Geometry, per minute (averages over the run)", "",
  "| | |", "|---|---|",
  `| Inter-satellite links | ${fmt(avg((s) => s.links))} (up to 4 per satellite, within 2,500 km and clear of the Earth and lower atmosphere) |`,
  `| Mean link length and light time | ${fmt(avg((s) => s.meanIslKm))} km, ${avg((s) => s.meanIslMs).toFixed(2)} ms |`,
  `| Links changing per minute as satellites move | ${fmt(churn / (st.length - 1))} (links are kept while geometry allows) |`,
  `| Ground stations with a satellite above 25 degrees | ${avg((s) => s.stationsUp).toFixed(1)} of ${c.gs.length} |`,
  `| Mean slant range to the chosen satellite | ${fmt(avg((s) => s.meanSlantKm))} km |`,
  `| Satellites with no link | ${fmt(avg((s) => s.isolated))} |`, "",
  "## Traffic and verification", "",
  "| | |", "|---|---|",
  `| Bundles | ${fmt(cfg.bundles)} from random satellites to mission operations |`,
  `| Delivered | ${fmt(run.delivered.length)} (${fmt(run.stranded.length)} still in flight) |`,
  `| Average path | ${base.avgHops.toFixed(1)} hops |`,
  `| Rerouted mid-transfer (in flight across a topology change) | ${fmt(run.crossedEpoch)} |`,
  `| Longer than their starting shortest path | ${fmt(run.detoured)} |`,
  `| Held in storage at least one tick | ${fmt(run.waited)} |`,
  `| Batch receipts | ${fmt(run.batches.length)} for ${fmt(run.hopEvents)} hop records |`,
  `| Verified end to end | ${fmt(base.verified)} of ${fmt(run.delivered.length)} (${base.failed} failures) |`,
  `| Simulation, verification | ${tSim}, ${tVerify} |`, "",
  "## Attacks", "",
  "| Attack | Bundles affected | Refused | Result |", "|---|---|---|---|",
  `| A rogue key signs a satellite's batch | ${rogueExpected} | ${rogue.failed} (${Object.keys(rogue.failures).join(", ")}) | ${rogue.failed === rogueExpected ? "PASS" : "FAIL"} |`,
  `| The busiest satellite (${victim}) is revoked as compromised mid-run | ${compExpected} | ${comp.failed} (${Object.keys(comp.failures).join(", ")}) | ${comp.failed === compExpected ? "PASS" : "FAIL"} |`, "",
  "## Limits", "",
  "- Positions and ground visibility are real (public elements, SGP4). The laser-link layout is a geometric model: operators do not publish theirs, and real terminals have pointing, slew and acquisition limits not modelled here.",
  "- Ground stations are public city locations standing in for gateways; station links use the two highest satellites above a 25-degree mask.",
  "- Transport is simulated one hop per tick; link light times are reported but not added to delivery time.",
];
const text = lines.join("\n") + "\n";
console.log(text);
console.log(`ORBITS_RESULT ${JSON.stringify({ ok, satellites: c.sats.length, delivered: run.delivered.length, verified: base.verified })}`);
if (process.argv.includes("--write")) writeFileSync(new URL("./ORBITS-RESULTS.md", import.meta.url), text);
process.exit(ok ? 0 : 1);
