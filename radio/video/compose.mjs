#!/usr/bin/env node
// Compose the /radio/ walkthrough from record.mjs's frames: 1920x1080, a caption panel per scene,
// the payer and payee screens side by side, a closing card, and the narration (out/vo*.mp3)
// placed at each scene's start. Writes out/walkthrough.mp4 and out/walkthrough-poster.jpg.
//
//   node radio/video/compose.mjs     (after narrate.py and record.mjs; needs Chrome and ffmpeg)
import { readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { launch } from "./cdp.mjs";

const here = fileURLToPath(new URL(".", import.meta.url)), OUT = join(here, "out");
const tl = JSON.parse(readFileSync(join(OUT, "timeline.json"), "utf8"));
const vo = JSON.parse(readFileSync(join(OUT, "vo.json"), "utf8"));

const CAPTIONS = [
  ["Pay with Bitcoin BSV, with no internet", "As a QR code, as sound, or as a text message"],
  ["Start with the guide", "Each part is a few steps"],
  ["Try a demo payment", "Signed but not spendable, and checked on your phone"],
  ["Pay face to face: QR code", "The other phone opens Get paid, enters its address, and scans"],
  ["Checked with no internet", "It pays them 1,000 sat, and waits in their outbox until they have a signal"],
  ["No camera? Pay by sound", "Made for walkie-talkies, AM and FM radio, and phone calls too. Those links are tested in simulation so far."],
  ["Or text it to a gateway", "Only a phone signal is needed. The gateway texts back a signed receipt, and the page checks it."],
  ["Faucets work too", "When one is announced, one tap texts your claim"],
  ["Try it", ""],
];

const css = `*{box-sizing:border-box;margin:0}html,body{width:1920px;height:1080px;overflow:hidden;background:#0e1116;color:#e6e9ee;font-family:"Segoe UI",system-ui,sans-serif}
.bg{position:absolute;inset:0;background:radial-gradient(1200px 800px at 75% 40%,#1a2233 0%,#0e1116 70%)}
.left{position:absolute;left:96px;top:0;width:780px;height:1080px;display:flex;flex-direction:column;justify-content:center}
.brand{position:absolute;left:96px;top:64px;font-size:26px;color:#9aa3b2;font-weight:600}.brand b{color:#E7A33E}
.step{font-size:24px;color:#E7A33E;font-weight:700;letter-spacing:.08em;margin-bottom:22px}
h1{font-size:64px;line-height:1.08;font-weight:800;margin-bottom:28px}
p{font-size:32px;line-height:1.4;color:#b8c0cc}
.phone{position:absolute;top:96px;width:440px;height:924px;border-radius:40px;background:#05070a;border:2px solid #2a313c;box-shadow:0 30px 80px rgba(0,0,0,.55)}
.label{position:absolute;top:40px;width:440px;text-align:center;font-size:24px;font-weight:700;color:#9aa3b2;letter-spacing:.06em}
.url{position:absolute;left:96px;bottom:64px;font-size:24px;color:#9aa3b2}`;

function bgHtml(i) {
  const [title, sub] = CAPTIONS[i];
  return `<style>${css}</style><div class="bg"></div><div class="brand"><b>BSVKey</b> · offline payment handoff</div>
  <div class="left"><div class="step">${i + 1} / ${CAPTIONS.length}</div><h1>${title}</h1><p>${sub}</p></div>
  <div class="label" style="left:968px">PAYER</div><div class="label" style="left:1424px">PAYEE</div>
  <div class="phone" style="left:968px"></div><div class="phone" style="left:1424px"></div>
  <div class="url">dtn.bsvkey.com/radio</div>`;
}
const cardHtml = `<style>${css}
.card{position:absolute;inset:0;background:rgba(14,17,22,.94);display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center}
.card h1{font-size:96px;margin-bottom:24px}.card .u{font-size:56px;color:#E7A33E;font-weight:800;margin-bottom:40px}.card p{font-size:34px}</style>
<div class="card"><h1>Pay offline with Bitcoin BSV</h1><div class="u">dtn.bsvkey.com/radio</div>
<p>QR code · sound · text message · faucets</p><p style="margin-top:18px">Free and open source: github.com/BSVKey/dtn-custody-demo</p>
<p style="margin-top:40px;font-size:26px;color:#9aa3b2">A payment checked offline is final only once it reaches the network. Wait for the receipt on large amounts.</p></div>`;

// ---- 1. scene backgrounds and the closing card, rendered by Chrome ----
const c = await launch({ port: 9410, width: 1920, height: 1080, dpr: 1, mobile: false });
for (let i = 0; i < CAPTIONS.length; i++) {
  await c.goto("data:text/html;charset=utf-8," + encodeURIComponent(bgHtml(i)));
  writeFileSync(join(OUT, `bg${i + 1}.png`), await c.png());
}
await c.send("Emulation.setDefaultBackgroundColorOverride", { color: { r: 0, g: 0, b: 0, a: 0 } });
await c.goto("data:text/html;charset=utf-8," + encodeURIComponent(cardHtml.replace("html,body{width:1920px;height:1080px;overflow:hidden;background:#0e1116", "html,body{width:1920px;height:1080px;overflow:hidden;background:transparent")));
writeFileSync(join(OUT, "card.png"), await c.png());
c.close();

// ---- 2. concat lists: backgrounds per scene, and each phone's frames at their real times ----
const L = tl.length;
const bg = tl.scenes.map((s, i) => `file '${join(OUT, `bg${i + 1}.png`).replace(/\\/g, "/")}'\nduration ${(s.end - s.start).toFixed(3)}`);
writeFileSync(join(OUT, "bg.txt"), bg.join("\n") + `\nfile '${join(OUT, "bg9.png").replace(/\\/g, "/")}'\n`);
for (const k of ["a", "b"]) {
  const f = tl.frames[k], lines = [];
  for (let i = 0; i < f.length; i++) lines.push(`file '${f[i].f.replace(/\\/g, "/")}'\nduration ${(((f[i + 1]?.t ?? L) - f[i].t) || 0.04).toFixed(3)}`);
  lines.push(`file '${f.at(-1).f.replace(/\\/g, "/")}'`);
  writeFileSync(join(OUT, `${k}.txt`), lines.join("\n") + "\n");
}

// ---- 3. picture, then narration at each scene's start ----
const T9 = tl.scenes[8].start;
const delays = tl.scenes.map((s) => Math.round((s.start + 0.35) * 1000));
const audioIn = vo.flatMap((v) => ["-i", join(OUT, v.file)]);
const mix = vo.map((_, i) => `[${4 + i}:a]adelay=${delays[i]}|${delays[i]}[v${i}]`).join(";") + ";" + vo.map((_, i) => `[v${i}]`).join("") + `amix=inputs=${vo.length}:normalize=0,loudnorm=I=-16:TP=-1.5:LRA=11[aud]`;
const graph = [
  "[0:v]fps=30,format=yuv420p[bg]",
  "[1:v]fps=30,scale=416:900:flags=lanczos[a]",
  "[2:v]fps=30,scale=416:900:flags=lanczos[b]",
  "[bg][a]overlay=980:108[t1]",
  "[t1][b]overlay=1436:108[t2]",
  `[3:v]format=rgba,fade=in:st=${T9.toFixed(2)}:d=0.7:alpha=1[card]`,
  `[t2][card]overlay=0:0:enable='gte(t,${T9.toFixed(2)})',format=yuv420p[vid]`,
  mix,
].join(";");
writeFileSync(join(OUT, "graph.txt"), graph);
execFileSync("ffmpeg", ["-y", "-v", "error",
  "-f", "concat", "-safe", "0", "-i", join(OUT, "bg.txt"),
  "-f", "concat", "-safe", "0", "-i", join(OUT, "a.txt"),
  "-f", "concat", "-safe", "0", "-i", join(OUT, "b.txt"),
  "-loop", "1", "-t", L.toFixed(2), "-i", join(OUT, "card.png"),
  ...audioIn,
  "-/filter_complex", join(OUT, "graph.txt"),
  "-map", "[vid]", "-map", "[aud]", "-t", L.toFixed(2),
  "-c:v", "libx264", "-preset", "medium", "-crf", "22", "-pix_fmt", "yuv420p", "-r", "30",
  "-c:a", "aac", "-b:a", "128k", "-movflags", "+faststart", join(OUT, "walkthrough.mp4")], { stdio: "inherit" });
execFileSync("ffmpeg", ["-y", "-v", "error", "-ss", "33", "-i", join(OUT, "walkthrough.mp4"), "-frames:v", "1", "-q:v", "3", join(OUT, "walkthrough-poster.jpg")]);
console.log(`out/walkthrough.mp4: ${L.toFixed(1)} s, 1920x1080`);
