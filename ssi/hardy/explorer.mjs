// Writes ssi/hardy/explorer.html from a run's saved outputs (ssi/hardy/out/<run>/), one
// self-contained page with no scripts.
//   node ssi/hardy/explorer.mjs <out-dir> [--txid=<settlement txid>]
import { readFileSync, writeFileSync } from "node:fs";
import { NODES, OPERATORS } from "../world.mjs";

const dir = process.argv[2];
const txid = (process.argv.find((a) => a.startsWith("--txid=")) || "").slice(7) || null;
const rep = JSON.parse(readFileSync(`${dir}/report.json`, "utf8"));
const res = JSON.parse(readFileSync(`${dir}/results.json`, "utf8"));
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const ENDPOINTS = { "ipn:1.0": "Mission operations", "ipn:51.0": "Lander payload", "ipn:61.0": "Rover payload" };
const name = (e) => ENDPOINTS[e] ?? NODES[e]?.name ?? e;
const short = (e) => name(e).replace(/ 70 m|Lunar relay |Operator A ground, | payload/g, "");
const opOf = (e) => NODES[e]?.op ?? "science";
const OPC = { ground: "var(--c1)", lunaA: "var(--c2)", lunaB: "var(--c3)", marsnet: "var(--c4)", science: "var(--c5)" };

const ledger = Object.entries(rep.settlement).map(([op, s]) => {
  const st = rep.statements?.[op];
  return `<tr><td><span class="sw" style="background:${OPC[op]}"></span>${esc(OPERATORS[op].name)}</td><td class="n">${s.bundles}</td><td class="n"><b>${s.amount}</b></td><td class="n">${s.refused}</td><td class="mono">${st ? esc(st.claimId.slice(0, 18)) + "…" : "none"}</td></tr>`;
}).join("");
const bundles = rep.bundles.map((b) => {
  const d = res.deliveries.find((x) => x.label === b.label) || {};
  const chips = b.signers.map((e) => `<span class="chip ${NODES[e] ? "hardy" : "js"}" style="border-color:${OPC[opOf(e)]}" title="${esc(name(e))}: ${NODES[e] ? "signed inside Hardy" : "signed by the JS endpoint"}">${esc(short(e))}</span>`).join('<span class="arr">›</span>');
  const gap = b.gaps?.length ? `<div class="note">unsigned: ${esc(short(b.gaps[0].lastUnsigned ?? "?"))}${b.gaps[0].unsignedNodes !== undefined ? `, ${b.gaps[0].unsignedNodes} node` : ""}</div>` : "";
  const gossip = d.revocationOnArrival ? `<div class="note">${d.revocationAtOrigin ? "carried the revocation from its origin" : "picked up the revocation on the way, from a Hardy node"}</div>` : "";
  return `<tr><td class="mono">${esc(b.label)}</td><td class="n">${b.latencyScenarioH} h</td><td>${chips}${gap}${gossip}</td><td class="${b.ok ? "ok" : "no"}">${b.ok ? "verified" : esc(b.reason)}</td></tr>`;
}).join("");
const heard = Object.entries(rep.revocationHeardAfterScenarioH || {}).map(([e, h]) => `<tr><td>${esc(name(e))}</td><td class="n">${h === null ? "not by the end" : h <= 0 ? "at once" : h + " h"}</td></tr>`).join("");
const forg = rep.forgeries.map((f) => `<tr><td>${esc(f.claim.replace(/^forged: /, ""))}</td><td class="mono no">${esc(f.outcome)}</td></tr>`).join("");
const g = rep.gossip || { arrivedWithRevocation: 0, addedOnTheWay: [] };

const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Solar System Internet on Hardy</title>
<style>
:root{--bg:#fbfaf7;--fg:#1d1b18;--mut:#6b655c;--line:#e4dfd6;--card:#fff;--c1:#2f6db5;--c2:#b8741a;--c3:#8a8172;--c4:#b5432f;--c5:#3d8a5a;--ok:#2f7d4a;--no:#b23a2a}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){--bg:#15140f;--fg:#ece7de;--mut:#a39c90;--line:#2e2b25;--card:#1d1b16;--c1:#6fa3e8;--c2:#e0a24c;--c3:#a69d8e;--c4:#e2735e;--c5:#6cc08a;--ok:#6cc08a;--no:#f0846f}}
:root[data-theme="dark"]{--bg:#15140f;--fg:#ece7de;--mut:#a39c90;--line:#2e2b25;--card:#1d1b16;--c1:#6fa3e8;--c2:#e0a24c;--c3:#a69d8e;--c4:#e2735e;--c5:#6cc08a;--ok:#6cc08a;--no:#f0846f}
a{color:var(--c1)} body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.5 system-ui,-apple-system,Segoe UI,sans-serif}
main{max-width:1000px;margin:0 auto;padding:28px 16px 60px} h1{font-size:28px;margin:0 0 6px;line-height:1.2} h2{font-size:19px;margin:34px 0 8px} .sub{color:var(--mut);margin:0 0 14px}
.stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px;margin:18px 0}.stat{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:12px 14px}.stat b{display:block;font-size:22px}.stat span{color:var(--mut);font-size:13px}
.wrap{overflow-x:auto;background:var(--card);border:1px solid var(--line);border-radius:10px;padding:10px} table{border-collapse:collapse;width:100%;font-size:14px} th,td{text-align:left;padding:7px 8px;border-bottom:1px solid var(--line);vertical-align:top} th{color:var(--mut);font-weight:600;font-size:12px;text-transform:uppercase;letter-spacing:.04em}
.n{text-align:right;white-space:nowrap}.mono{font-family:ui-monospace,Consolas,monospace;font-size:12.5px}.ok{color:var(--ok)}.no{color:var(--no)}.sw{display:inline-block;width:10px;height:10px;border-radius:2px;margin-right:7px;vertical-align:-1px}
.chip{display:inline-block;border:1.5px solid;border-radius:6px;padding:0 5px;font-size:12px;margin:1px 0;white-space:nowrap}.chip.js{border-style:dotted}.arr{color:var(--mut);margin:0 2px}.note{color:var(--mut);font-size:13px;margin-top:6px}
.legend .chip{margin-right:6px}
</style></head><body><main>
<p class="note" style="margin:0 0 14px"><a href="/">DTN Custody</a> · <a href="/ssi/">The simulated run</a> · <a href="https://github.com/BSVKey/dtn-custody-demo/tree/main/ssi/hardy">Code and results (Apache-2.0)</a></p>
<h1>Solar System Internet on real Bundle Protocol agents</h1>
<p class="sub">The same five operators and geometry as <a href="/ssi/">the simulated run</a>, with every spacecraft and station a real Aalyria Hardy BPA that signs custody receipts inside the BPA, routes with its own time-variant routing agent, and holds bundles in its own store. The space links are emulated (contact windows, light time and rates); time is compressed ${esc(rep.scale)} times, ${esc(rep.hours)} scenario hours in ${Math.round((rep.hours * 60) / rep.scale)} minutes.</p>
<div class="stats">
<div class="stat"><b>${rep.hardyNodes}</b><span>Hardy BPAs</span></div>
<div class="stat"><b>${rep.delivered} / ${rep.sent}</b><span>bundles delivered</span></div>
<div class="stat"><b>${rep.receipts.byHardy}</b><span>receipts signed inside Hardy</span></div>
<div class="stat"><b>${rep.forgeries.length} / ${rep.forgeries.length}</b><span>forged claims refused</span></div>
<div class="stat"><b>${g.addedOnTheWay.length}</b><span>bundles that picked up the revocation from a Hardy node</span></div>
</div>

<h2>Who earned what</h2>
<p class="sub">From the receipts alone, each statement signed by the clearing house.${txid ? ` Paid on Bitcoin BSV in one transaction: <a class="mono" href="https://whatsonchain.com/tx/${esc(txid)}">${esc(txid)}</a>.` : ""}</p>
<div class="wrap"><table><tr><th>Operator</th><th class="n">Bundles</th><th class="n">Amount</th><th class="n">Refused</th><th>Signed statement</th></tr>${ledger}</table></div>

<h2>A relay key is stolen</h2>
<p class="sub">Lunar relay A-2's signing key is copied mid-run and revoked from that moment. Mission operations has the revocation at once and sends it out with its commands; Hardy nodes that carry it learn it and add it to every bundle they forward.</p>
<div class="wrap"><table><tr><th>Endpoint</th><th class="n">Heard the revocation after it was issued</th></tr>${heard}</table></div>
<p class="note">${g.arrivedWithRevocation} bundles arrived carrying the revocation; ${g.addedOnTheWay.length} of them had left their origin without it and picked it up from a Hardy node on the way${g.addedOnTheWay.length ? ` (${esc(g.addedOnTheWay.join(", "))})` : ""}. Honest receipts A-2 cannot bill, signed between the theft and the revocation: ${rep.honestLossAfterTheft}.</p>
<div class="wrap" style="margin-top:12px"><table><tr><th>Forged claim with the stolen key</th><th>Clearing</th></tr>${forg}</table></div>

<h2>Every bundle</h2>
<p class="sub legend"><span class="chip" style="border-color:var(--mut)">solid</span>signed inside Hardy · <span class="chip js" style="border-color:var(--mut)">dotted</span>signed by a JS endpoint · unsigned relays are named and sized from the receipts on either side</p>
<div class="wrap"><table><tr><th>Bundle</th><th class="n">Took</th><th>Custodians, in order</th><th>At destination</th></tr>${bundles}</table></div>
<p class="note">Real: ten Hardy BPAs (custody-receipt filter, routing agents, storage). Emulated: the space links. Routes computed by contact graph routing from the geometry and loaded into Hardy's routing agents. Amounts in an abstract unit${txid ? ", paid in sats at a stated rate" : ""}. Generated by ssi/hardy/explorer.mjs.</p>
</main></body></html>`;
writeFileSync(new URL("./explorer.html", import.meta.url), html);
console.log(`[ssi-hardy] explorer.html written (${(html.length / 1024).toFixed(0)} KB)`);
