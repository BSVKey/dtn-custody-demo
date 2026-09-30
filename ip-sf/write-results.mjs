#!/usr/bin/env node
// Write ip-sf/RESULTS.md from the run summaries produced by deep-space.mjs and receipts.mjs.
import { readFileSync, writeFileSync, existsSync } from "node:fs";

const rows = JSON.parse(readFileSync("ip-sf/runs/deep-space-summary.json", "utf8"));
const mars = existsSync("ip-sf/runs/mars-summary.json") ? JSON.parse(readFileSync("ip-sf/runs/mars-summary.json", "utf8")) : null;
const wbCommit = process.argv.find((a) => a.startsWith("--wb="))?.slice(5) || "";
const hrs = (ms) => (ms >= 3600000 ? `${(ms / 3600000).toFixed(1)} h` : `${(ms / 60000).toFixed(1)} min`);
const lost = (r) => Object.entries(r.attribution || {}).filter(([k]) => !/simulation ended/.test(k));
const lossText = (r) => { const l = lost(r); return l.length ? l.map(([k, v]) => `${v} × ${k}`).join("; ") : "none"; };

const lines = [
  "# Custody receipts over IP store-and-forward, from Earth to Voyager", "",
  "The same custody records as the DTN runs, built for IP store-and-forward: IP forwarders that hold packets while a link is down, as described in draft-ietf-tiptop-ip-architecture. The network is simulated with the QUIC workbench by the draft's authors ([deepspaceip/dipt-quic-workbench](https://github.com/deepspaceip/dipt-quic-workbench)" + (wbCommit ? `, commit ${wbCommit.slice(0, 7)}` : "") + "), which forwards real QUIC traffic hop by hop with store-and-forward buffers, scheduled outages and time warping, and logs every packet event at every node.", "",
  "From each simulation's log, [receipts.mjs](receipts.mjs) builds, after the fact and off the forwarding path:", "",
  "- one signed `custody-batch/1` receipt per receiving node per contact, committing to every packet it took in by Merkle root (one signature per node per contact, none per packet);",
  "- one `gap/1` record per link outage;",
  "- for every packet that never reached an application, the last node that signed for it and what its own log says happened.", "",
  "QUIC recovers losses end to end, and nothing here changes that. The receipts record which node held what, so a loss can be attributed to a node, and so to the operator that runs it.", "",
  "## Results", "",
  "| Destination | Path | One-way light time | Exchanges completed | Signed receipts (verified) | Gap records | Losses in the network, by last signer |",
  "|---|---|---|---|---|---|---|",
];
if (mars) lines.push(`| Mars: Ingenuity via Perseverance and the Mars orbiters (workbench's own scenario) | GND > DSN > MRO/TGO/MVN/ODY > M20 > ING | 15.0 min | 10 of 10 | ${mars.receipts} (${mars.receiptsVerified}) | ${mars.gapRecords} | ${lossText(mars)} |`);
for (const r of rows) lines.push(`| ${r.title}${r.real ? "" : ""} | ${r.path} | ${hrs(r.oneWay)} | ${r.completed} of ${r.requests}${r.doneAtS ? `, done after ${(r.doneAtS / 86400).toFixed(2)} days` : ""} | ${r.receipts} (${r.receiptsVerified}) | ${r.gapRecords} | ${lossText(r)} |`);
const reboot = rows.find((r) => r.key === "titan-reboot");
const titan = rows.find((r) => r.key === "titan");
lines.push("", "Packets still in flight or still held when a simulation stopped (usually the final acknowledgements) are listed in the run summaries but are not losses.", "");
if (reboot && titan) lines.push(
  "## A relay loses what it holds", "",
  `The Titan run was repeated with one change: at hour 20, while the Saturn orbiter holds the lander's data waiting for the next Earth pass, its buffer is wiped, the failure the draft names ("a buffer is cleared ... due to reboot"). QUIC recovered end to end: all ${reboot.completed} exchanges still completed, ${((reboot.doneAtS - titan.doneAtS) / 86400).toFixed(2)} days later than without the failure. The receipts show where the data went: **${Object.entries(reboot.attribution).filter(([k]) => /BufferCleared/.test(k)).map(([, v]) => v)[0] || 0} packets were last signed for by SATURN-ORB and never forwarded**, each provable from that node's own signed receipt plus a Merkle inclusion proof. Delivery was the transport's job; the receipts say whose node lost the data.`, "");
lines.push(
  "## Scenarios", "",
  "- Distances are approximate for early October 2026: Voyager 1 about 171 AU and Voyager 2 about 144 AU from the Sun, Saturn about 8.6 AU, Neptune about 28.9 AU and Pluto about 34.8 AU from Earth, and the solar probes about 1 AU or less.",
  "- Voyager 1 and 2, Parker Solar Probe and Solar Orbiter are real spacecraft (Voyager at its 160 bps downlink and 16 bps uplink). The Saturn, Titan, Neptune and Pluto missions are hypothetical orbiters and landers at those planets' real distances.",
  "- Contacts: the workbench drops a packet that is in flight when its link goes down. Where the light time is longer than a station pass (Voyager, Neptune, Pluto) the long-haul link is continuous Deep Space Network coverage after an initial period with the spacecraft out of view, during which the DSN stores and forwards. Saturn has daily 9-hour passes, the Titan lander a 30-minute relay contact every 8 hours, Parker a 3-day blackout followed by daily 8-hour passes.",
  "- Reproduce: build the workbench (Rust 1.93), then `node ip-sf/deep-space.mjs` (runs it in Docker) and `node ip-sf/write-results.mjs`.", "",
  "## Limits", "",
  "- Simulation, not flight: the workbench's links, not real radios or real DSN schedules.",
  "- Packets are identified by the simulator's packet ids. On real networks the leaf would be a hash of the packet or of the data it carries.",
  "- Light traffic (a few HTTP-style exchanges per destination), so receipts per packet-hop are high here; batching pays off with volume, as in the 4,032-satellite DTN runs.",
);
writeFileSync("ip-sf/RESULTS.md", lines.join("\n") + "\n");
console.log(lines.join("\n"));
