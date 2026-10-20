#!/usr/bin/env node
// Record the /radio/ walkthrough: two phones (payer and payee) driven in headless Chrome against
// the live page. The payee's camera is fed the payer's real QR code and its microphone the
// payment's real sound (Chrome's fake capture devices), so the scan and the listen in the video
// are the page really decoding them. Frames go to radio/video/out/{a,b}/ with their times.
//
//   node radio/video/record.mjs        (needs Chrome, ffmpeg, and out/vo.json from narrate.py)
import { mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { PrivateKey } from "@bsv/sdk";
import { launch, sleep } from "./cdp.mjs";
import { smsGateway } from "../sms/gateway.mjs";

const here = fileURLToPath(new URL(".", import.meta.url));
const OUT = join(here, "out"), PAGE = process.env.PAGE_URL || "https://dtn.bsvkey.com/radio/";
const vo = JSON.parse(readFileSync(join(OUT, "vo.json"), "utf8"));
for (const d of ["a", "b"]) { rmSync(join(OUT, d), { recursive: true, force: true }); mkdirSync(join(OUT, d), { recursive: true }); }
const PAYEE = PrivateKey.fromRandom().toAddress();
const GW = PrivateKey.fromRandom(), GW_NUMBER = "+15551234567"; // fictional number, for the demo only
const FAUCET = `BSVF1 5a1e0f00 1000 sat each, 500 of 500 left. Send BSV1 CLAIM <your address> to ${GW_NUMBER}`;

// ---- 1. the payment, its QR code and its sound, made on the live page ----
const prep = await launch({ port: 9400 });
await prep.goto(PAGE);
const payment = await prep.eval(`(async () => {
  document.getElementById("myAddr").value = ${JSON.stringify(PAYEE)};
  document.getElementById("demo").click(); await new Promise(r => setTimeout(r, 900));
  document.getElementById("showQr").click(); await new Promise(r => setTimeout(r, 300));
  return { text: window.handoff.current().text, png: document.getElementById("qr").toDataURL("image/png") };
})()`);
prep.close();
writeFileSync(join(OUT, "payment.txt"), payment.text);
writeFileSync(join(OUT, "qr.png"), Buffer.from(payment.png.split(",")[1], "base64"));
execFileSync("ffmpeg", ["-y", "-v", "error", "-loop", "1", "-i", join(OUT, "qr.png"), "-vf", "scale=420:420,pad=640:480:110:30:white,format=yuv420p", "-t", "6", "-r", "15", join(OUT, "qr.y4m")]);
execFileSync("node", [join(here, "../audio/make-wav.mjs"), "--channel", "speaker", "--speed", "fastest", "--repeat", "1", "--payment", join(OUT, "payment.txt"), "--out", join(OUT, "pay.wav")], { stdio: "ignore" });
const receipt = await smsGateway({ key: GW }).handle("+15550000000", payment.text);

// ---- 2. two phones ----
const A = await launch({ port: 9401 });
const B = await launch({ port: 9402, video: join(OUT, "qr.y4m"), audio: join(OUT, "pay.wav") });
await Promise.all([A.goto(PAGE), B.goto(PAGE)]);
const t0 = Date.now(), now = () => (Date.now() - t0) / 1000;
const frames = { a: [], b: [] };
let recording = true;
const capture = async (p, k) => { let n = 0; while (recording) { const t = now(), jpg = await p.shot(); const f = join(OUT, k, `${String(n++).padStart(5, "0")}.jpg`); writeFileSync(f, jpg); frames[k].push({ f, t }); } };
const loops = [capture(A, "a"), capture(B, "b")];

const js = (p, code) => p.eval(`(async () => { const $ = (id) => document.getElementById(id); const wait = (ms) => new Promise(r => setTimeout(r, ms));
  const show = (el, block = "center") => el.scrollIntoView({ behavior: "smooth", block });
  const type = async (el, text) => { el.focus(); el.value = ""; for (const ch of text) { el.value += ch; el.dispatchEvent(new Event("input")); await wait(35); } el.dispatchEvent(new Event("change")); };
  ${code} })()`);

const scenes = [];
async function scene(i, minS, actions) {
  const start = now();
  await actions();
  const until = start + Math.max(minS, vo[i - 1].seconds + 1.0);
  while (now() < until) await sleep(50);
  scenes.push({ scene: i, start, end: now() });
  console.log(`scene ${i}: ${start.toFixed(1)}-${now().toFixed(1)} s`);
}

await scene(1, 0, async () => { await js(B, `await wait(4500); document.querySelector('[data-tab="get"]').click(); show(document.querySelector(".tabs"), "start");`); });
await scene(2, 0, async () => { await js(A, `const s = document.querySelectorAll("#guide details.step")[1]; s.open = true; show(s);`); });
await scene(3, 0, async () => {
  await js(A, `$("guide").open = false; show($("demo"), "start"); await wait(900); $("demo").click(); await wait(500);
    const { tx, type: kind } = window.handoff.readPayment(${JSON.stringify(payment.text)}); window.handoff.setPayment(tx, kind);
    $("payStatus").innerHTML = '<div class="status warn">Demo payment: signed correctly, but its funding is made up, so a gateway can check it and the network would refuse it.</div>';
    show($("payStatus"));`);
});
await scene(4, 0, async () => {
  await js(A, `$("showQr").click(); await wait(300); show($("qrBox"));`);
  await js(B, `show($("myAddr")); await wait(400); await type($("myAddr"), ${JSON.stringify(PAYEE)}); await type($("want"), "1000"); await wait(300); $("scan").click(); await wait(600); show($("video"));`);
});
await scene(5, 0, async () => {
  await js(B, `for (let i = 0; i < 80 && !$("getStatus").textContent.startsWith("Signed correctly"); i++) await wait(100); show($("getStatus")); await wait(3200); show($("outbox"));`);
});
await scene(6, 0, async () => {
  await js(A, `$("speed").value = "fastest"; $("speed").dispatchEvent(new Event("change")); show($("play")); await wait(500); $("play").click(); await wait(300); show($("playMeter"));`);
  await js(B, `$("stop").click(); show($("listen")); await wait(500); $("listen").click(); await wait(300); show($("micMeter"));`);
  for (let i = 0; i < 400; i++) { const done = await js(B, `return $("getStatus").textContent.startsWith("Signed correctly")`); if (done) break; await sleep(50); }
  await js(B, `show($("getStatus"));`);
  await sleep(1500);
});
await scene(7, 0, async () => {
  await js(A, `document.querySelector('[data-tab="settings"]').click(); show($("gwNumber")); await wait(300);
    await type($("gwNumber"), ${JSON.stringify(GW_NUMBER)}); $("gwPub").value = ${JSON.stringify(GW.toPublicKey().toString())}; $("gwPub").dispatchEvent(new Event("change"));
    await wait(500); document.querySelector('[data-tab="pay"]').click(); show($("smsLink")); $("smsLink").style.outline = "3px solid var(--accent)"; await wait(3200);
    $("smsLink").style.outline = ""; show($("receipt")); await wait(500); $("receipt").value = ${JSON.stringify(receipt)}; await wait(700); $("checkReceipt").click(); await wait(200); show($("receiptStatus"));`);
});
await scene(8, 0, async () => {
  await js(B, `$("stop").click(); show($("getPaste")); await wait(300); await type($("getPaste"), ${JSON.stringify(FAUCET)}); $("getLoad").click(); await wait(300); show($("faucets"));`);
});
await scene(9, vo[8].seconds + 1.6, async () => {});

recording = false;
await Promise.all(loops);
A.close(); B.close();
writeFileSync(join(OUT, "timeline.json"), JSON.stringify({ scenes, frames, length: now() }, null, 1));
console.log(`recorded ${now().toFixed(1)} s: ${frames.a.length} + ${frames.b.length} frames`);
