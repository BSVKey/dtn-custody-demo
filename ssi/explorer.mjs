// Writes ssi/explorer.html: one self-contained page from a run (no scripts from anywhere else).
//   node ssi/explorer.mjs
import { writeFileSync } from "node:fs";
import { runSSI } from "./run.mjs";
import { NODES, OPERATORS } from "./world.mjs";

const { result: r, net, contacts } = runSSI();
const H = 3.6e6, start = Date.parse(r.period.from), end = Date.parse(r.period.to);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const OPC = { ground: "var(--c1)", lunaA: "var(--c2)", lunaB: "var(--c3)", marsnet: "var(--c4)", science: "var(--c5)" };
const hh = (t) => ((t - start) / H).toFixed(1);

// Contact timeline: one row per undirected space link, bars where it is up.
const W = 900, rowH = 16, left = 230;
const pairs = new Map();
for (const c of contacts) {
  if (NODES[c.from].kind === "moc" || NODES[c.to].kind === "moc") continue;
  const k = [c.from, c.to].sort().join("|");
  if (!pairs.has(k)) pairs.set(k, []);
  if (c.from < c.to) pairs.get(k).push(c);
}
const x = (t) => left + ((t - start) / (end - start)) * (W - left - 10);
let rows = "", y = 22;
for (const [k, cs] of pairs) {
  const [a, b] = k.split("|");
  rows += `<text x="${left - 8}" y="${y + 11}" text-anchor="end" class="lbl">${esc(NODES[a].name)} · ${esc(NODES[b].name)}</text>`;
  for (const c of cs) rows += `<rect x="${x(c.start).toFixed(1)}" y="${y + 2}" width="${Math.max(1, x(c.end) - x(c.start)).toFixed(1)}" height="${rowH - 6}" rx="2" fill="${OPC[NODES[c.from].op]}"><title>${esc(NODES[c.from].name)} to ${esc(NODES[c.to].name)}: ${hh(c.start)} h to ${hh(c.end)} h, light time ${c.owltMs} ms</title></rect>`;
  y += rowH;
}
let axis = "";
for (let h = 0; h <= 72; h += 12) axis += `<line x1="${x(start + h * H)}" x2="${x(start + h * H)}" y1="16" y2="${y}" class="grid"/><text x="${x(start + h * H)}" y="12" text-anchor="middle" class="lbl">+${h} h</text>`;
const evX = (t) => x(Date.parse(t));
axis += `<line x1="${evX(r.compromise.stolenAt)}" x2="${evX(r.compromise.stolenAt)}" y1="16" y2="${y}" class="ev"/><line x1="${evX(r.compromise.detectedAt)}" x2="${evX(r.compromise.detectedAt)}" y1="16" y2="${y}" class="ev2"/>`;
const timeline = `<svg viewBox="0 0 ${W} ${y + 6}" role="img" aria-label="Contact windows over 72 hours">${axis}${rows}</svg>`;

const ledger = Object.entries(r.settlement).map(([op, s]) => `<tr><td><span class="sw" style="background:${OPC[op]}"></span>${esc(s.name)}</td><td class="n">${s.bundles}</td><td class="n">${s.megabytes}</td><td class="n">${OPERATORS[op].ratePerMB}</td><td class="n"><b>${s.amount}</b></td><td class="n">${s.rejectedReceipts}</td><td class="mono">${s.statement ?? "none: carried " + (r.unsignedHopsByOperator[op] || 0) + " hops unsigned"}</td></tr>`).join("");
const prop = r.compromise.propagation.map((p) => {
  const w = p.heardAfterH === null ? 0 : Math.max(2, (p.heardAfterH / 30) * 100);
  return `<tr><td><span class="sw" style="background:${OPC[p.op]}"></span>${esc(p.name)}</td><td><div class="bar" style="width:${w}%"></div></td><td class="n">${p.heardAfterH === null ? "never" : p.heardAfterH === 0 ? "at once (ground)" : p.heardAfterH + " h"}</td></tr>`;
}).join("");
const forg = r.forgeries.map((f) => `<tr><td>${esc(f.claim)}</td><td class="mono no">${esc(f.outcome)}</td></tr>`).join("");
const bundles = net.deliveries.slice().sort((a, b) => a.created - b.created).map((d) => {
  const chips = d.path.map((p) => `<span class="chip ${p.signed ? "" : "un"}" style="border-color:${OPC[NODES[p.node].op]}" title="${esc(NODES[p.node].name)}${p.signed ? ", signed" : ", did not sign"}">${esc(NODES[p.node].name.replace(/ 70 m|Lunar relay |Operator A ground, /g, ""))}</span>`).join("<span class=\"arr\">›</span>");
  return `<tr><td class="mono">${esc(d.id)}</td><td class="n">+${hh(d.created)} h</td><td class="n">${((d.deliveredAt - d.created) / H).toFixed(2)} h</td><td>${chips}</td><td class="${d.atDest.ok ? "ok" : "no"}">${d.atDest.ok ? "verified" : esc(d.atDest.reason)}</td></tr>`;
}).join("");

const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Accountable Solar System Internet</title>
<style>
:root{--bg:#fbfaf7;--fg:#1d1b18;--mut:#6b655c;--line:#e4dfd6;--card:#fff;--c1:#2f6db5;--c2:#b8741a;--c3:#8a8172;--c4:#b5432f;--c5:#3d8a5a;--ok:#2f7d4a;--no:#b23a2a}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){--bg:#15140f;--fg:#ece7de;--mut:#a39c90;--line:#2e2b25;--card:#1d1b16;--c1:#6fa3e8;--c2:#e0a24c;--c3:#a69d8e;--c4:#e2735e;--c5:#6cc08a;--ok:#6cc08a;--no:#f0846f}}
:root[data-theme="dark"]{--bg:#15140f;--fg:#ece7de;--mut:#a39c90;--line:#2e2b25;--card:#1d1b16;--c1:#6fa3e8;--c2:#e0a24c;--c3:#a69d8e;--c4:#e2735e;--c5:#6cc08a;--ok:#6cc08a;--no:#f0846f}
a{color:var(--c1)}
body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.5 system-ui,-apple-system,Segoe UI,sans-serif}
main{max-width:1000px;margin:0 auto;padding:28px 16px 60px}
h1{font-size:28px;margin:0 0 6px;line-height:1.2} h2{font-size:19px;margin:34px 0 8px} .sub{color:var(--mut);margin:0 0 14px}
.stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px;margin:18px 0}
.stat{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:12px 14px}.stat b{display:block;font-size:22px}.stat span{color:var(--mut);font-size:13px}
.wrap{overflow-x:auto;background:var(--card);border:1px solid var(--line);border-radius:10px;padding:10px}
table{border-collapse:collapse;width:100%;font-size:14px} th,td{text-align:left;padding:7px 8px;border-bottom:1px solid var(--line);vertical-align:top} th{color:var(--mut);font-weight:600;font-size:12px;text-transform:uppercase;letter-spacing:.04em}
.n{text-align:right;white-space:nowrap}.mono{font-family:ui-monospace,Consolas,monospace;font-size:12.5px}.ok{color:var(--ok)}.no{color:var(--no)}
.sw{display:inline-block;width:10px;height:10px;border-radius:2px;margin-right:7px;vertical-align:-1px}
.bar{height:10px;border-radius:5px;background:var(--c2);min-width:2px}
svg{width:100%;min-width:760px;height:auto}.lbl{font-size:10px;fill:var(--mut)}.grid{stroke:var(--line)}.ev{stroke:var(--no);stroke-width:1.5;stroke-dasharray:3 3}.ev2{stroke:var(--ok);stroke-width:1.5;stroke-dasharray:3 3}
.chip{display:inline-block;border:1.5px solid;border-radius:6px;padding:0 5px;font-size:12px;margin:1px 0;white-space:nowrap}.chip.un{border-style:dashed;opacity:.75}.arr{color:var(--mut);margin:0 2px}
.note{color:var(--mut);font-size:13px;margin-top:8px}
</style></head><body><main>
<p class="note" style="margin:0 0 14px"><a href="https://dtn.bsvkey.com/">DTN Custody</a> · <a href="https://dtn.bsvkey.com/ssi/hardy/">The same network on real Hardy BPAs</a> · <a href="https://github.com/BSVKey/dtn-custody-demo/tree/main/ssi">Code and results (Apache-2.0)</a></p>
<h1>Accountable Solar System Internet</h1>
<p class="sub">One simulated 72-hour run from ${esc(r.period.from.slice(0, 10))}: five independent operators, contacts computed from the positions of Earth stations, the Moon, Mars and relay orbiters, real Bundle Protocol v7 bundles routed by contact graph routing, a custody receipt at every signing node, keys and revocations carried inside the traffic, a stolen relay key, and settlement between operators from receipts alone.</p>
<div class="stats">
<div class="stat"><b>${r.bundles.delivered} / ${r.bundles.sent}</b><span>bundles delivered</span></div>
<div class="stat"><b>${r.receipts}</b><span>custody receipts signed</span></div>
<div class="stat"><b>${r.contacts}</b><span>contacts from geometry</span></div>
<div class="stat"><b>${r.forgeries.length} / ${r.forgeries.length}</b><span>forged claims refused</span></div>
<div class="stat"><b>${Object.values(r.signedPlans).filter((p) => p.ok).length}</b><span>operator contact plans signed and checked</span></div>
</div>

<h2>Who earned what</h2>
<p class="sub">Credited only for receipts that verify: the right key for the node, valid at the time it claims, not revoked, in an unbroken chain. Paid by the bundle's owner at each operator's rate per MB. Each statement is signed by the clearing house.</p>
<div class="wrap"><table><tr><th>Operator</th><th class="n">Bundles</th><th class="n">MB</th><th class="n">Rate</th><th class="n">Amount</th><th class="n">Refused</th><th>Signed statement</th></tr>${ledger}</table></div>
<p class="note">Operator B ran no custodian: its relay carried ${r.unsignedHopsByOperator.lunaB || 0} hops, each reported as one unsigned node by the hop count, and none of it can be billed.</p>

<h2>A relay key is stolen</h2>
<p class="sub">The key of ${esc(r.compromise.victimName)} is copied at +${hh(Date.parse(r.compromise.stolenAt))} h (red line below). Its operator revokes it from that moment and issues a replacement at +${hh(Date.parse(r.compromise.detectedAt))} h (green line). The ground knows at once; spacecraft hear only through the traffic that reaches them.</p>
<div class="wrap"><table><tr><th>Node</th><th style="width:45%">Revocation heard after detection</th><th class="n"></th></tr>${prop}</table></div>
<p class="note">The relay itself switched to its new key ${r.compromise.victimSwitchedKeyAfterH} h after detection. ${r.compromise.staleKeyDeliveries} delivery carried its old key from after the theft and was refused; ${r.compromise.acceptedAtDestinationBeforeTheyHeard} were accepted by a destination that had not heard yet.</p>
<h2>Forged billing with the stolen key</h2>
<div class="wrap"><table><tr><th>Claim</th><th>Clearing</th></tr>${forg}</table></div>

<h2>Every contact, from geometry</h2>
<p class="sub">Bars are windows when a pair can see each other, coloured by the transmitting operator. Hover for times and light time.</p>
<div class="wrap">${timeline}</div>

<h2>Every bundle</h2>
<p class="sub">Path as routed hop by hop; a dashed node forwarded without signing. Verified at the destination with the destination's own keyring.</p>
<div class="wrap"><table><tr><th>Bundle</th><th class="n">Sent</th><th class="n">Took</th><th>Path</th><th>At destination</th></tr>${bundles}</table></div>
<p class="note">Simulation: positions from low-precision ephemerides, idealized links, illustrative rates and prices, generic operators. Generated by ssi/explorer.mjs in BSVKey/dtn-custody-demo.</p>
</main></body></html>`;
writeFileSync(new URL("./explorer.html", import.meta.url), html);
console.log(`[ssi] explorer.html written (${(html.length / 1024).toFixed(0)} KB)`);
