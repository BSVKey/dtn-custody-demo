// Hub dashboard: one page and one JSON endpoint, no dependencies.
//   GET /            the coordination view (reports, urgent items, custody routes, holds,
//                    relay payouts, refusals); refreshes itself every 5 s
//   GET /api/state   the same data as JSON
// Binds to 127.0.0.1 by default: decrypted reports are health data. Expose it on a wider
// interface only behind your own access control.
import http from "node:http";

export function startDashboard({ state, host = "127.0.0.1", port = 8080, title = "Relief hub" }) {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://x");
    if (url.pathname === "/api/state") {
      res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
      return res.end(JSON.stringify(state()));
    }
    if (url.pathname === "/") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "content-security-policy": "default-src 'self'; style-src 'unsafe-inline'; script-src 'unsafe-inline'" });
      return res.end(page(title));
    }
    res.writeHead(404).end("not found");
  });
  return new Promise((resolve) => server.listen(port, host, () => resolve({ port: server.address().port, close: () => server.close() })));
}

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

function page(title) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title>
<style>
:root{--bg:#f6f7f9;--card:#fff;--ink:#16181d;--mute:#5d6470;--line:#e2e5ea;--ok:#127a3e;--warn:#9a5b00;--bad:#b42318;--accent:#1f5fbf}
@media (prefers-color-scheme:dark){:root{--bg:#101215;--card:#181b20;--ink:#e8eaee;--mute:#9aa2ae;--line:#2a2f37;--ok:#4cc27e;--warn:#e0a640;--bad:#f07067;--accent:#7aa7ff}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.45 system-ui,-apple-system,Segoe UI,Roboto,sans-serif}
header{padding:20px 16px 8px;max-width:1100px;margin:auto}h1{font-size:22px;margin:0}header p{margin:4px 0 0;color:var(--mute)}
main{max-width:1100px;margin:auto;padding:8px 16px 40px;display:grid;gap:16px}
.stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px}
.stat,.card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:14px}
.stat b{display:block;font-size:26px}.stat span{color:var(--mute);font-size:13px}
h2{font-size:16px;margin:0 0 10px}table{width:100%;border-collapse:collapse}th,td{text-align:left;padding:8px 6px;border-top:1px solid var(--line);vertical-align:top}
th{color:var(--mute);font-weight:600;font-size:13px;border-top:0}.scroll{overflow-x:auto}
.ok{color:var(--ok)}.warn{color:var(--warn)}.bad{color:var(--bad)}.mute{color:var(--mute)}.urgent{color:var(--bad);font-weight:600}
code{font:12px ui-monospace,Menlo,Consolas,monospace;color:var(--mute)}
</style></head><body>
<header><h1>${esc(title)}</h1><p>Verified field reports: every chunk, every handoff and every payout checked against pinned keys.</p></header>
<main>
<section class="stats" id="stats"></section>
<section class="card"><h2>Urgent</h2><div id="urgent" class="mute">Nothing urgent reported.</div></section>
<section class="card"><h2>Reports</h2><div class="scroll"><table><thead><tr><th>Clinic</th><th>Status</th><th>Report</th><th>Route and holds</th></tr></thead><tbody id="reports"></tbody></table></div></section>
<section class="card"><h2>Relay payouts (verified custody only)</h2><div class="scroll"><table><thead><tr><th>Relay</th><th>Bundles</th><th>Sats</th></tr></thead><tbody id="payouts"></tbody></table></div></section>
<section class="card"><h2>Refused</h2><div class="scroll"><table><thead><tr><th>When</th><th>What</th><th>Reason</th></tr></thead><tbody id="refusals"></tbody></table></div></section>
<p class="mute" id="updated"></p>
</main>
<script>
const esc=(s)=>String(s??"").replace(/[&<>"']/g,(c)=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"})[c]);
const name=(e)=>esc(String(e||"").replace(/^dtn:\\/\\//,"").replace(/\\.dtn\\/$|\\/$/,""));
const mins=(ms)=>ms>=60000?Math.round(ms/60000)+" min":Math.max(0,Math.round(ms/1000))+" s";
function summary(s){if(!s||typeof s!=="object")return"";const p=[];if(s.patientsSeen!=null)p.push(s.patientsSeen+" patients");if(s.referrals!=null)p.push(s.referrals+" referral"+(s.referrals===1?"":"s"));if(s.supplies)p.push("needs: "+Object.entries(s.supplies).map(([k,v])=>v+" "+k).join(", "));return esc(p.join("; "))}
async function tick(){
 let s;try{s=await (await fetch("api/state",{cache:"no-store"})).json()}catch{document.getElementById("updated").textContent="Hub not reachable; retrying.";return}
 const rep=s.reports,ver=rep.filter(r=>r.status==="verified"),pay=Object.entries(s.payouts),sats=pay.reduce((a,[,p])=>a+p.sats,0);
 document.getElementById("stats").innerHTML=[[ver.length,"reports verified"],[rep.filter(r=>r.status==="in_transit").length,"in transit"],[s.refusals.length,"refused"],[sats.toLocaleString(),"sats owed to relays"]].map(([b,t])=>"<div class=stat><b>"+b+"</b><span>"+t+"</span></div>").join("");
 const urg=ver.flatMap(r=>(r.summary?.urgent||[]).map(u=>"<div><span class=urgent>"+esc(u)+"</span> <span class=mute>("+name(r.clinic)+")</span></div>"));
 document.getElementById("urgent").innerHTML=urg.length?urg.join(""):"Nothing urgent reported.";
 document.getElementById("reports").innerHTML=rep.slice().reverse().map(r=>{
  const st=r.status==="verified"?"<span class=ok>verified</span>":r.status==="in_transit"?"<span class=warn>in transit "+r.received+"/"+(r.chunkCount??"?")+"</span>":"<span class=bad>refused: "+esc(r.reason)+"</span>";
  const route=(r.route||[]).map(name).join(" &rarr; ");const holds=(r.holds||[]).map(h=>"<div class=warn>held "+mins(h.transitMs)+" on "+name(h.from)+" &rarr; "+name(h.to)+"</div>").join("");
  return "<tr><td>"+name(r.clinic)+"</td><td>"+st+"</td><td>"+(r.file?esc(r.file.name)+"<div class=mute>"+summary(r.summary)+"</div>":"")+"</td><td>"+route+holds+"</td></tr>"}).join("")||"<tr><td colspan=4 class=mute>No reports yet.</td></tr>";
 document.getElementById("payouts").innerHTML=pay.map(([e,p])=>"<tr><td>"+name(e)+"</td><td>"+p.bundles+"</td><td>"+p.sats.toLocaleString()+"</td></tr>").join("")||"<tr><td colspan=3 class=mute>None yet.</td></tr>";
 document.getElementById("refusals").innerHTML=s.refusals.slice().reverse().map(f=>"<tr><td>"+new Date(f.at).toLocaleTimeString()+"</td><td>"+(f.payloadId?esc(f.payloadId)+(f.index!=null?" chunk "+f.index:""):"frame")+(f.claimedBy?"<div class=mute>claimed by "+name(f.claimedBy)+"</div>":"")+"</td><td class=bad><code>"+esc(f.reason)+"</code></td></tr>").join("")||"<tr><td colspan=3 class=mute>None.</td></tr>";
 document.getElementById("updated").textContent="Updated "+new Date(s.generatedAt).toLocaleTimeString()+" from "+s.hub;
}
tick();setInterval(tick,5000);
</script></body></html>`;
}
