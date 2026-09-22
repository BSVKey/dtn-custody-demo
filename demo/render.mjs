// Renders demo/dtn.cast to demo/out/dtn-demo.mp4 (+ .gif) with no extra installs:
// a tiny terminal emulator replays the cast into frames, headless Chrome (DevTools
// protocol) screenshots each frame inside a branded window, and ffmpeg stitches them
// with the cast's real timing. Ends on a card showing the anchor tx on WhatsOnChain.
//
// Usage: node demo/render.mjs   (needs Chrome + ffmpeg on PATH)
import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync } from "node:fs";
import { spawn, execFileSync } from "node:child_process";
import { pathToFileURL, fileURLToPath } from "node:url";
import { join } from "node:path";

const here = fileURLToPath(new URL(".", import.meta.url));
const OUT = join(here, "out"), FR = join(OUT, "frames");
const CHROME = process.env.CHROME || "C:/Program Files/Google/Chrome/Application/chrome.exe";
const ANCHOR = "https://whatsonchain.com/tx/d49777e46abe6dfa02586d3ab81f91c52fb9026dd667d6adafd848fa8889e8ca";
rmSync(OUT, { recursive: true, force: true }); mkdirSync(FR, { recursive: true });

// ---- 1. replay the cast through a minimal terminal emulator ----------------------
const [hdr, ...evs] = readFileSync(join(here, "dtn.cast"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
const W = hdr.width, H = hdr.height;
const PAL = { 30: "#6f6a5e", 31: "#f2544b", 32: "#7BC98A", 33: "#E7A33E", 34: "#7fb2ff", 35: "#d4a5ff", 36: "#4FD1C5", 37: "#EDE7D8",
  90: "#7d776a", 91: "#ff6b62", 92: "#8fe0a0", 93: "#f5bd5c", 94: "#9cc4ff", 95: "#e0bcff", 96: "#6fe3d8", 97: "#ffffff" };
let scr, cx, cy, fg = null;
const blank = () => Array.from({ length: W }, () => ({ c: " ", f: null }));
const clear = () => { scr = Array.from({ length: H }, blank); cx = 0; cy = 0; };
clear();
const nl = () => { cy++; if (cy >= H) { scr.shift(); scr.push(blank()); cy = H - 1; } };
const put = (ch) => { if (cx >= W) { cx = 0; nl(); } scr[cy][cx] = { c: ch, f: fg }; cx++; };
function sgr(ps) {
  const p = ps ? ps.split(";").map(Number) : [0];
  for (let i = 0; i < p.length; i++) {
    const n = p[i];
    if (n === 0 || n === 39) fg = null;
    else if (n === 38 && p[i + 1] === 5) { fg = "#E7A33E"; i += 2; }
    else if (PAL[n]) fg = PAL[n];
  }
}
function feed(s) {
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === "\x1b" && s[i + 1] === "[") {
      let j = i + 2, ps = "";
      while (j < s.length && /[0-9;?]/.test(s[j])) ps += s[j++];
      const fin = s[j]; i = j; ps = ps.replace("?", "");
      if (fin === "m") sgr(ps);
      else if (fin === "J" && (ps === "2" || ps === "")) clear();
      else if (fin === "H") { cx = 0; cy = 0; }
      else if (fin === "K") for (let x = cx; x < W; x++) scr[cy][x] = { c: " ", f: null };
      else if (fin === "G") cx = Math.max(0, (parseInt(ps) || 1) - 1);
      continue;
    }
    if (ch === "\x1b") { i++; continue; }
    if (ch === "\r") { cx = 0; continue; }
    if (ch === "\n") { nl(); continue; }
    if (ch === "\t") { do put(" "); while (cx % 8); continue; }
    if (ch < " ") continue;
    put(ch);
  }
}
const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;");
function snapshot() {
  return scr.map((row, y) => {
    let html = "", run = "", col;
    const flush = () => { if (run) html += col ? `<span style="color:${col}">${esc(run)}</span>` : esc(run); run = ""; };
    row.forEach((cell, x) => {
      if (x === cx && y === cy) { flush(); html += `<span class="cur">${esc(cell.c)}</span>`; col = undefined; return; }
      if (cell.f !== col) { flush(); col = cell.f; }
      run += cell.c;
    });
    flush();
    return html;
  }).join("\n");
}
const frames = []; // { t, html }
evs.forEach(([t, , data], i) => {
  feed(data);
  const next = evs[i + 1] ? evs[i + 1][0] : t + 1;
  if (next - t >= 0.04 || !evs[i + 1]) frames.push({ t, html: snapshot() });
});

// ---- 2. branded terminal page ------------------------------------------------------
const page = `<!doctype html><html><head><meta charset="utf-8"><style>
html,body{margin:0;width:1920px;height:1080px;overflow:hidden;background:radial-gradient(1200px 700px at 20% 0%,#2a2218,#0E0D0B 70%)}
.win{position:absolute;left:120px;top:36px;width:1680px;height:1008px;background:#17150F;border:1px solid #2A271F;border-radius:16px;box-shadow:0 30px 80px rgba(0,0,0,.55);overflow:hidden}
.bar{height:46px;display:flex;align-items:center;gap:10px;padding:0 18px;background:#1E1B14;border-bottom:1px solid #2A271F;font:500 17px Consolas,monospace;color:#B0A68F}
.d{width:13px;height:13px;border-radius:50%} .t{flex:1;text-align:center} .u{color:#E7A33E}
pre{margin:0;padding:18px 26px;font:26px/1.18 Consolas,"IBM Plex Mono",monospace;color:#EDE7D8;white-space:pre}
.cur{background:#E7A33E;color:#17150F}
</style></head><body><div class="win"><div class="bar"><span class="d" style="background:#f2544b"></span><span class="d" style="background:#E7A33E"></span><span class="d" style="background:#7BC98A"></span><span class="t">dtn-custody-demo · bash</span><span class="u">dtn.bsvkey.com</span></div><pre id="s"></pre></div></body></html>`;
const pagePath = join(OUT, "term.html");
writeFileSync(pagePath, page);

// ---- 3. drive headless Chrome over the DevTools protocol ---------------------------
const chrome = spawn(CHROME, ["--headless=new", "--remote-debugging-port=9333", `--user-data-dir=${join(OUT, "chrome-profile")}`,
  "--window-size=1920,1080", "--hide-scrollbars", "--no-first-run", "about:blank"], { stdio: "ignore" });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let target;
for (let i = 0; i < 60 && !target; i++) {
  try { target = (await (await fetch("http://127.0.0.1:9333/json/list")).json()).find((x) => x.type === "page"); } catch {}
  if (!target) await sleep(250);
}
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener("open", r));
let id = 0; const pending = new Map();
ws.addEventListener("message", (m) => { const d = JSON.parse(m.data); if (d.id && pending.has(d.id)) { pending.get(d.id)(d); pending.delete(d.id); } });
const cdp = (method, params = {}) => new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
const shot = async (file) => { const r = await cdp("Page.captureScreenshot", { format: "png" }); writeFileSync(file, Buffer.from(r.result.data, "base64")); };

await cdp("Page.enable");
await cdp("Emulation.setDeviceMetricsOverride", { width: 1920, height: 1080, deviceScaleFactor: 1, mobile: false });
await cdp("Page.navigate", { url: pathToFileURL(pagePath).href });
await sleep(800);
for (let i = 0; i < frames.length; i++) {
  await cdp("Runtime.evaluate", { expression: `document.getElementById('s').innerHTML=${JSON.stringify(frames[i].html)}` });
  await shot(join(FR, `f${String(i).padStart(4, "0")}.png`));
}

// end card: the real anchor transaction, read from the WhatsOnChain API (the website
// itself serves a bot check to headless browsers), next to the Merkle root recomputed
// from the anchored payload. The card is the proof: the two roots match.
const TXID = ANCHOR.split("/").pop();
const tx = await (await fetch(`https://api.whatsonchain.com/v1/bsv/main/tx/hash/${TXID}`)).json();
const opr = tx.vout.find((o) => o.scriptPubKey && (o.scriptPubKey.type === "nulldata" || /^006a/.test(o.scriptPubKey.hex || "")));
const scriptHex = opr.scriptPubKey.hex;
const { leafHash, buildTree } = await import("../agent/lib/merkle.mjs");
const { chunk } = await import("../agent/source.mjs");
const root = buildTree(chunk(readFileSync(join(here, "../live/anchored-payload.txt")), 64).map((c) => leafHash(c))).root;
const match = scriptHex.includes(root);
const when = tx.blocktime ? new Date(tx.blocktime * 1000).toISOString().replace("T", " ").slice(0, 16) + " UTC" : "pending";
const hl = scriptHex.replace(root, `<b>${root}</b>`);
const card = `<!doctype html><html><head><meta charset="utf-8"><style>
html,body{margin:0;width:1920px;height:1080px;overflow:hidden;background:radial-gradient(1200px 700px at 80% 100%,#2a2218,#0E0D0B 70%);font-family:Consolas,monospace;color:#EDE7D8}
.box{position:absolute;left:116px;top:180px;width:1580px;background:#17150F;border:1px solid #39352A;border-radius:16px;box-shadow:0 30px 80px rgba(0,0,0,.55);padding:44px 54px}
h1{margin:0 0 6px;font-size:44px;font-weight:600} h1 i{font-style:normal;color:#E7A33E}
.src{color:#7d776a;font-size:22px;margin-bottom:34px}
.k{color:#B0A68F;font-size:22px;margin-top:22px} .v{font-size:27px;word-break:break-all;margin-top:6px}
.v b{color:#E7A33E;font-weight:600} .ok{color:#7BC98A;font-size:34px;margin-top:34px;font-weight:600}
.cap{position:absolute;left:0;right:0;bottom:44px;text-align:center;color:#B0A68F;font-size:26px}
</style></head><body><div class="box">
<h1>Provenance anchor, <i>on chain</i></h1>
<div class="src">read live from api.whatsonchain.com · BSV mainnet</div>
<div class="k">transaction</div><div class="v">${TXID}</div>
<div class="k">block ${tx.blockheight ?? "?"} · ${when} · ${tx.confirmations ?? 0} confirmations</div>
<div class="k">OP_RETURN output script</div><div class="v">${hl}</div>
<div class="k">Merkle root recomputed from live/anchored-payload.txt</div><div class="v"><b>${root}</b></div>
<div class="ok">${match ? "✓ roots match: the payload is exactly what was anchored" : "✗ roots do not match"}</div>
</div><div class="cap">github.com/BSVKey/dtn-custody-demo · dtn.bsvkey.com · Apache-2.0</div></body></html>`;
if (!match) console.error("WARNING: anchored root does not match recomputed root");
writeFileSync(join(OUT, "card.html"), card);
await cdp("Page.navigate", { url: pathToFileURL(join(OUT, "card.html")).href });
await sleep(900);
await shot(join(FR, "zcard.png"));
ws.close(); chrome.kill();

// ---- 4. stitch with real timing ----------------------------------------------------
let list = "";
frames.forEach((f, i) => {
  const d = i + 1 < frames.length ? Math.max(0.04, frames[i + 1].t - f.t) : 1.5;
  list += `file 'frames/f${String(i).padStart(4, "0")}.png'\nduration ${d.toFixed(3)}\n`;
});
list += `file 'frames/zcard.png'\nduration 6\nfile 'frames/zcard.png'\n`;
writeFileSync(join(OUT, "list.txt"), list);
const ff = (args) => execFileSync("ffmpeg", ["-y", "-loglevel", "error", ...args], { cwd: OUT, stdio: "inherit" });
ff(["-f", "concat", "-safe", "0", "-i", "list.txt", "-vf", "fps=30,format=yuv420p", "-c:v", "libx264", "-crf", "18", "-preset", "slow", "-movflags", "+faststart", "dtn-demo.mp4"]);
ff(["-i", "dtn-demo.mp4", "-vf", "fps=12,scale=960:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=128[p];[b][p]paletteuse=dither=bayer", "dtn-demo.gif"]);
console.log(`rendered ${frames.length} frames -> demo/out/dtn-demo.mp4 + dtn-demo.gif`);
