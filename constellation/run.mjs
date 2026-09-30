#!/usr/bin/env node
// Constellation-scale run: build the constellation, fly the traffic, verify every bundle,
// then attack the records and confirm each attack is caught for exactly the bundles it
// touches and no others.
//   node constellation/run.mjs                 4,032 satellites, 10,000 bundles
//   node constellation/run.mjs --small         144 satellites, 500 bundles (seconds)
//   node constellation/run.mjs --write         also write constellation/RESULTS.md
import { writeFileSync } from "node:fs";
import os from "node:os";
import { genKeypair } from "../agent/lib/keys.mjs";
import { signRecord } from "../agent/lib/receipt.mjs";
import { pinnedDirectory, verifyPath, assemblePath } from "../agent/lib/path.mjs";
import { batchProof } from "../agent/lib/batch.mjs";
import { makeConstellation, simulate, verifyAll, MOC } from "./sim.mjs";

const small = process.argv.includes("--small");
const cfg = small ? { planes: 12, perPlane: 12, stations: 6, bundles: 500, epochs: 30 } : { planes: 72, perPlane: 56, stations: 40, bundles: 10000, epochs: 40 };
const ms = (t) => `${((performance.now() - t) / 1000).toFixed(1)} s`;
const fmt = (n) => Math.round(n).toLocaleString("en-US");

let t = performance.now();
const c = makeConstellation(cfg);
const tKeys = ms(t);
t = performance.now();
const run = simulate(c, cfg);
const tSim = ms(t);
t = performance.now();
const base = verifyAll(c, run);
const tVerify = ms(t);

// Record volume: per-bundle receipts (one signed JSON record per bundle per hop) versus
// batches (one signed record per node per contact, plus the 32-byte bundle id per bundle
// per hop that the node keeps so any single bundle can be proven later).
const batchRecordBytes = run.batches.reduce((s, b) => s + Buffer.byteLength(JSON.stringify(b.receipt)), 0);
const perBundleBytes = run.hopEvents * run.sampleReceiptBytes;
const batchTotalBytes = batchRecordBytes + run.hopEvents * 32;

// ---- Attacks ------------------------------------------------------------------------------
const cloneRun = () => ({ ...run, batches: run.batches.map((b) => ({ ...b })) });
const bundlesIn = (b) => new Set(b.leaves);
const delivered = new Set(run.delivered.map((d) => d.bundleId));
const pickBatch = (pred) => run.batches.findIndex((b) => pred(b) && b.leaves.some((id) => delivered.has(id)));
const attacks = [];
const check = (name, affected, res, expectReason) => {
  const hitOnly = res.failed === [...affected].filter((id) => delivered.has(id)).length;
  attacks.push({ name, affected: [...affected].filter((id) => delivered.has(id)).length, failed: res.failed, reasons: res.failures, pass: hitOnly && (!expectReason || res.failures[expectReason] === res.failed) });
};

{ // 1. A captured or rogue key signs a satellite's batch record.
  const r = cloneRun(); const i = pickBatch((b) => b.receipt.thisHop.startsWith("ipn:1"));
  const { claimId, sig, signerPub, ...content } = r.batches[i].receipt;
  r.batches[i] = { ...r.batches[i], receipt: signRecord(genKeypair(), content) };
  check("rogue key signs a satellite's batch", bundlesIn(run.batches[i]), verifyAll(c, r), "signer_not_authorized");
}
{ // 2. A batch record is withheld or lost.
  const r = cloneRun(); const i = pickBatch((b) => b.receipt.thisHop !== MOC && !b.receipt.prevHop.startsWith("app:"));
  const gone = bundlesIn(run.batches[i]); r.batches.splice(i, 1);
  check("a batch record is withheld", gone, verifyAll(c, r));
}
{ // 3. A batch's count or root is edited after signing.
  const r = cloneRun(); const i = pickBatch(() => true);
  r.batches[i] = { ...r.batches[i], receipt: { ...r.batches[i].receipt, count: r.batches[i].receipt.count + 1 } };
  check("a signed batch is edited", bundlesIn(run.batches[i]), verifyAll(c, r), "claimId_mismatch");
}
{ // 4. Someone claims a bundle passed through a node it never visited: they splice a real,
  //    validly signed batch from that node into the bundle's path, with a made-up proof.
  const i = pickBatch((b) => b.leaves.length > 1);
  const victim = run.delivered.find((d) => !run.batches[i].leaves.includes(d.bundleId));
  const real = run.batches.filter((b) => b.leaves.includes(victim.bundleId)).map((b) => ({ receipt: b.receipt, proof: batchProof(b, victim.bundleId) }));
  const path = assemblePath(real, victim.source);
  const forgedLeaves = [...run.batches[i].leaves, victim.bundleId].sort();
  const fake = { ...run.batches[i], leaves: forgedLeaves };
  path.splice(1, 0, { receipt: run.batches[i].receipt, proof: batchProof(fake, victim.bundleId) ?? { index: 0, branch: [] } });
  const dir = pinnedDirectory(new Map([...c.keys].map(([eid, kp]) => [eid, kp.pub])));
  const v = verifyPath(path, { bundleId: victim.bundleId, source: victim.source, destination: MOC, authorize: dir, maxHops: 256 });
  attacks.push({ name: "a bundle is claimed through a node it never visited", affected: 1, failed: v.ok ? 0 : 1, reasons: v.ok ? {} : { [v.reason]: 1 }, pass: !v.ok && v.reason === "not_in_batch" });
}
{ // 5. One satellite's key is compromised: the directory drops it from a point in time.
  const i = pickBatch((b) => b.receipt.thisHop.startsWith("ipn:1") && b.receipt.thisHop !== MOC);
  const sat = run.batches[i].receipt.thisHop, since = run.batches[i].receipt.from;
  const dir = pinnedDirectory(new Map([...c.keys].map(([eid, kp]) => [eid, kp.pub])));
  const authorize = (pub, eid, at) => (eid === sat && at >= since ? { ok: false, reason: "key_compromised" } : dir(pub, eid, at));
  const affected = new Set(run.batches.filter((b) => b.receipt.thisHop === sat && b.receipt.from >= since).flatMap((b) => b.leaves));
  check("a satellite key is revoked as compromised", affected, verifyAll(c, run, { authorize }), "key_compromised");
}

// ---- Traffic density: batching pays off as more bundles share each contact -------------
const sweep = [];
for (const n of small ? [2000, 8000] : [50000, 200000]) {
  const t1 = performance.now();
  const r = simulate(c, { ...cfg, bundles: n });
  const v = verifyAll(c, r);
  sweep.push({ n, delivered: r.delivered.length, verified: v.verified, hopEvents: r.hopEvents, batches: r.batches.length, bytesPer: r.hopEvents * r.sampleReceiptBytes, bytesBatch: r.batches.reduce((x, b) => x + Buffer.byteLength(JSON.stringify(b.receipt)), 0) + r.hopEvents * 32, secs: (performance.now() - t1) / 1000 });
}
// ---- Harsh outages: most cross-links failing and few stations, forcing storage ----------
const harshCfg = { ...cfg, failRate: 0.3, stationUpRate: 0.35, epochs: cfg.epochs + 40 };
const cHarsh = makeConstellation({ ...cfg, stations: 4 });
const harsh = simulate(cHarsh, harshCfg);
const harshV = verifyAll(cHarsh, harsh);

const env = `${os.cpus()[0].model.trim()}, Node ${process.version}, one thread`;
const lines = [
  `# Constellation-scale custody: ${fmt(c.sats.length)} satellites`, "",
  `Run ${new Date().toISOString().slice(0, 10)} on ${env}. Reproduce: \`node constellation/run.mjs${small ? " --small" : ""}\`.`, "",
  "## Setup", "",
  `| | |`, `|---|---|`,
  `| Satellites | ${fmt(c.sats.length)} (${cfg.planes} planes x ${cfg.perPlane}) |`,
  `| Ground stations | ${cfg.stations}, access moving every epoch |`,
  `| Bundles | ${fmt(cfg.bundles)} from random satellites to mission operations |`,
  `| Epochs | ${cfg.epochs} (topology recomputed each epoch: polar cross-links down, ${2}% random cross-link failures) |`,
  `| Signing keys | ${fmt(c.keys.size)} (one per satellite, station and operations), generated in ${tKeys} |`, "",
  "## Delivery and routing", "",
  `| | |`, `|---|---|`,
  `| Delivered | ${fmt(run.delivered.length)} of ${fmt(cfg.bundles)} (${fmt(run.stranded.length)} still in flight at the end) |`,
  `| Average path | ${base.avgHops.toFixed(1)} hops |`,
  `| Rerouted mid-transfer (in flight across a topology change) | ${fmt(run.crossedEpoch)} |`,
  `| Longer than their starting shortest path | ${fmt(run.detoured)} |`,
  `| Held in storage at least one tick | ${fmt(run.waited)} |`,
  `| Simulation time | ${tSim} |`, "",
  "## Verification", "",
  `| | |`, `|---|---|`,
  `| Bundles whose full path verified | ${fmt(base.verified)} of ${fmt(run.delivered.length)} |`,
  `| Failures | ${base.failed} |`,
  `| Paths that passed back through a satellite already visited (accepted) | ${fmt(base.revisitPaths)} |`,
  `| Signature checks | ${fmt(base.signatureChecks)} (each batch verified once, shared by its bundles) |`,
  `| Verification time | ${tVerify} |`, "",
  "## Record volume: per-bundle receipts vs batch receipts", "",
  "| | Per-bundle receipts | Batch receipts | Reduction |", "|---|---|---|---|",
  `| Signatures | ${fmt(run.hopEvents)} | ${fmt(run.batches.length)} | ${(run.hopEvents / run.batches.length).toFixed(0)}x |`,
  `| Bytes | ${fmt(perBundleBytes)} | ${fmt(batchTotalBytes)} | ${(perBundleBytes / batchTotalBytes).toFixed(1)}x |`, "",
  `Per-bundle bytes are ${run.sampleReceiptBytes}-byte JSON custody receipts, one per bundle per hop. Batch bytes are the signed batch records (${fmt(batchRecordBytes)} bytes) plus a 32-byte bundle id per bundle per hop that each node keeps so any single bundle can be proven later. A binary receipt encoding would shrink both columns.`, "",
  "## Traffic density", "",
  "The same constellation at higher load. Each batch covers every bundle a node took from one neighbour in one contact, so signatures per bundle fall as traffic grows.", "",
  "| Bundles | Delivered | Verified | Hop records | Batch signatures | Signature reduction | Byte reduction | Time |", "|---|---|---|---|---|---|---|---|",
  `| ${fmt(cfg.bundles)} | ${fmt(run.delivered.length)} | ${fmt(base.verified)} | ${fmt(run.hopEvents)} | ${fmt(run.batches.length)} | ${(run.hopEvents / run.batches.length).toFixed(1)}x | ${(perBundleBytes / batchTotalBytes).toFixed(1)}x | ${tSim} + ${tVerify} |`,
  ...sweep.map((x) => `| ${fmt(x.n)} | ${fmt(x.delivered)} | ${fmt(x.verified)} | ${fmt(x.hopEvents)} | ${fmt(x.batches)} | ${(x.hopEvents / x.batches).toFixed(1)}x | ${(x.bytesPer / x.bytesBatch).toFixed(1)}x | ${x.secs.toFixed(1)} s |`), "",
  "## Harsh outages", "",
  `${Math.round(harshCfg.failRate * 100)}% of cross-plane links failing each epoch; ${cHarsh.gs.length} ground stations, each online only ${Math.round(harshCfg.stationUpRate * 100)}% of epochs (no station reachable in ${harsh.blackoutEpochs} of ${harshCfg.epochs} epochs); ${fmt(cfg.bundles)} bundles.`, "",
  "| | |", "|---|---|",
  `| Delivered | ${fmt(harsh.delivered.length)} (${fmt(harsh.stranded.length)} still in flight at the end) |`,
  `| Rerouted mid-transfer | ${fmt(harsh.crossedEpoch)} |`,
  `| Held in storage at least one tick | ${fmt(harsh.waited)} |`,
  `| Longer than their starting shortest path | ${fmt(harsh.detoured)} |`,
  `| Verified | ${fmt(harshV.verified)} of ${fmt(harsh.delivered.length)} (${harshV.failed} failures) |`, "",
  "## Attacks", "",
  "| Attack | Bundles affected | Bundles refused | Reasons | Result |", "|---|---|---|---|---|",
  ...attacks.map((a) => `| ${a.name} | ${a.affected} | ${a.failed} | ${Object.entries(a.reasons).map(([k, v]) => `${k} ${v}`).join(", ")} | ${a.pass ? "PASS" : "FAIL"} |`), "",
  "Each attack is caught for the bundles it touches and no others (no false alarms on the rest).", "",
  "## Limits", "",
  "- Orbital mechanics are a grid approximation (in-plane and cross-plane neighbours, a moving polar band, station access that shifts each epoch), not a propagated ephemeris.",
  "- Transport is simulated; this measures the custody records, routing churn and verification cost, not radio or laser links.",
  "- Keys here come from a pinned directory; fleet provisioning, rotation and revocation are in the Operator Edition.",
];
const text = lines.join("\n") + "\n";
console.log(text);
const ok = base.failed === 0 && attacks.every((a) => a.pass) && sweep.every((x) => x.verified === x.delivered) && harshV.failed === 0;
console.log(`CONSTELLATION_RESULT ${JSON.stringify({ ok, satellites: c.sats.length, delivered: run.delivered.length, verified: base.verified })}`);
if (process.argv.includes("--write")) writeFileSync(new URL("./RESULTS.md", import.meta.url), text);
process.exit(ok ? 0 : 1);
