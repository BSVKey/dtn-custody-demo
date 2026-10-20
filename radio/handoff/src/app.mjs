// The phone page: hand a signed Bitcoin BSV payment over with no internet (QR code, sound, or a
// text to an SMS gateway), check it offline on the receiving phone, and check the gateway's
// signed receipt. Uses radio/lib and radio/sms unchanged, so it checks exactly what the gateway
// checks.
import qrcode from "qrcode-generator";
import jsQR from "jsqr";
import ggwaveFactory from "ggwave";
import { PrivateKey, Transaction } from "@bsv/sdk";
import { TYPE } from "../../lib/frame.mjs";
import { encodePayment, decodePayment, checkOffline, paysAddress, buildRadioPayment, demoPayment } from "../../lib/payment.mjs";
import { paymentTexts, parseText, textAssembler, readReceiptText } from "../../sms/text.mjs";
import { soundChunks, parseChunk, soundAssembler, ggwaveCodec, QUIET } from "../../lib/sound.mjs";
import { parseAnnouncement, parseCoinLine, sweepCoinLine, claimText } from "../../faucet/faucet.mjs";

const $ = (id) => document.getElementById(id);
const store = {
  get(k, d = "") { try { return localStorage.getItem(`handoff.${k}`) ?? d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(`handoff.${k}`, v); } catch {} },
};
// sms: links take the number as is: keep only + and digits (no percent-encoding of the +)
const smsHref = (n, body) => `sms:${n.replace(/[^+0-9]/g, "")}?&body=${encodeURIComponent(body)}`;
const short = (h) => `${h.slice(0, 10)}...${h.slice(-6)}`;
const ARC = "https://arc.gorillapool.io";
const QR_SINGLE_MAX = 1200; // longer payments cycle through several codes

function status(el, kind, text) { el.innerHTML = ""; const d = document.createElement("div"); d.className = `status ${kind}`; d.textContent = text; el.append(d); }
function summary(el, rows) { el.innerHTML = ""; for (const [k, v] of rows) { const dt = document.createElement("dt"); dt.textContent = k; const dd = document.createElement("dd"); dd.textContent = v; el.append(dt, dd); } el.classList.remove("hidden"); }

// ---------- tabs and settings ----------
for (const b of document.querySelectorAll("[data-tab]")) b.onclick = () => {
  for (const x of document.querySelectorAll("[data-tab]")) x.setAttribute("aria-selected", String(x === b));
  for (const p of document.querySelectorAll("[data-panel]")) p.classList.toggle("hidden", p.dataset.panel !== b.dataset.tab);
};
for (const id of ["gwNumber", "gwPub", "speed", "myAddr", "want"]) { const el = $(id); el.value = store.get(id, el.value); el.onchange = () => { store.set(id, el.value.trim()); refreshSms(); }; }

// ---------- ggwave, loaded once ----------
let codecPromise = null, audio = null;
function audioCtx() { audio ??= new (window.AudioContext || window.webkitAudioContext)(); return audio; }
const codec = () => (codecPromise ??= ggwaveFactory(QUIET).then((gg) => ggwaveCodec(gg, { sampleRate: audioCtx().sampleRate })));

// ---------- pay ----------
let current = null; // { tx, type, msg, text }

function setPayment(tx, type) {
  const { msg } = type === TYPE.PAY_BEEF ? encodePayment(tx, { beef: true }) : encodePayment(tx);
  const check = checkOffline(tx);
  const text = paymentTexts(type, msg)[0];
  current = { tx, type, msg, text, check };
  if (check.ok) status($("payStatus"), "good", "Signed correctly. Ready to hand over.");
  else status($("payStatus"), "bad", `This payment does not check out: ${check.reason}`);
  const outs = tx.outputs.map((o) => `${o.satoshis} sat`).join(", ");
  summary($("paySummary"), [["txid", short(tx.id("hex"))], ["outputs", outs], ["fee", check.ok ? `${check.fee} sat` : "?"], ["size", `${msg.length} bytes, ${type === TYPE.PAY_BEEF ? "BEEF" : "EF"}`]]);
  for (const id of ["showQr", "play", "copy"]) $(id).disabled = !check.ok;
  $("qrBox").classList.add("hidden");
  refreshSms();
}

function refreshSms() {
  const n = $("gwNumber").value.trim(), a = $("smsLink");
  if (current?.check.ok && n) { a.href = smsHref(n, current.text); a.classList.remove("hidden"); }
  else a.classList.add("hidden");
}

// accepts EF hex, BEEF hex, or a BSV1 text
function readPayment(input) {
  const s = input.trim();
  const t = parseText(s);
  if (t?.msg) return { tx: decodePayment(t.type, t.msg), type: t.type };
  if (t) throw new Error("that is one part of a payment sent in several texts; paste the whole payment");
  const hex = s.replace(/\s+/g, "");
  if (!/^[0-9a-f]+$/i.test(hex)) throw new Error("not hex, and not a BSV1 text");
  const bytes = Buffer.from(hex, "hex");
  try { return { tx: decodePayment(TYPE.PAY_EF, bytes), type: TYPE.PAY_EF }; } catch {}
  try { return { tx: decodePayment(TYPE.PAY_BEEF, bytes), type: TYPE.PAY_BEEF }; } catch {}
  throw new Error("not an EF or BEEF payment. A plain raw transaction lacks the amounts needed to check it offline");
}

$("demo").onclick = async () => {
  const to = $("myAddr").value.trim() || PrivateKey.fromRandom().toAddress();
  const { tx } = await demoPayment({ to, sats: 1000 });
  setPayment(tx, TYPE.PAY_EF);
  status($("payStatus"), "warn", "Demo payment: signed correctly, but its funding is made up, so a gateway can check it and the network would refuse it.");
};
$("load").onclick = () => { try { const { tx, type } = readPayment($("paste").value); setPayment(tx, type); } catch (e) { status($("payStatus"), "bad", e.message); } };
$("sign").onclick = async () => {
  try {
    const payer = PrivateKey.fromWif($("wif").value.trim());
    const fundTx = Transaction.fromHex($("fund").value.trim());
    const tx = await buildRadioPayment({ payer, fundTx, to: $("to").value.trim(), sats: Number($("sats").value) });
    $("wif").value = "";
    setPayment(tx, TYPE.PAY_EF);
  } catch (e) { status($("payStatus"), "bad", e.message); }
};
$("copy").onclick = async () => { try { await navigator.clipboard.writeText(current.text); $("copy").textContent = "Copied"; setTimeout(() => ($("copy").textContent = "Copy text"), 1500); } catch { prompt("Copy this:", current.text); } };

// QR: one code, or a loop of codes for a long payment
let qrTimer = null;
function drawQr(text) {
  const q = qrcode(0, "M"); q.addData(text, "Byte"); q.make();
  const n = q.getModuleCount(), scale = Math.max(2, Math.floor(720 / n)), c = $("qr"), g = c.getContext("2d");
  c.width = c.height = n * scale;
  g.fillStyle = "#fff"; g.fillRect(0, 0, c.width, c.height); g.fillStyle = "#000";
  for (let r = 0; r < n; r++) for (let col = 0; col < n; col++) if (q.isDark(r, col)) g.fillRect(col * scale, r * scale, scale, scale);
}
$("showQr").onclick = () => {
  clearInterval(qrTimer);
  const parts = current.text.length <= QR_SINGLE_MAX ? [current.text] : paymentTexts(current.type, current.msg, { maxChars: 600 });
  let i = 0;
  const show = () => { drawQr(parts[i]); $("qrNote").textContent = parts.length > 1 ? `Code ${i + 1} of ${parts.length}: keep scanning until all are in` : "Let the other phone scan this"; i = (i + 1) % parts.length; };
  show();
  if (parts.length > 1) qrTimer = setInterval(show, 900);
  $("qrBox").classList.remove("hidden");
};

// Sound: each chunk, with a short gap; played twice so a missed chunk gets a second chance
$("play").onclick = async () => {
  const btn = $("play"), meter = $("playMeter"), bar = meter.firstElementChild, note = $("playNote");
  btn.disabled = true; meter.classList.remove("hidden"); note.classList.remove("hidden");
  try {
    note.textContent = "Getting the sound ready...";
    const c = await codec(), ctx = audioCtx();
    await ctx.resume();
    const chunks = soundChunks(current.type, current.msg), speed = $("speed").value || "fast";
    const order = [...chunks, ...chunks];
    // over a walkie-talkie or a call, give push-to-talk (or the line) a moment before the first tone
    if (speed.startsWith("dt")) { note.textContent = "Press and hold talk now, with the phone at the radio's microphone..."; await new Promise((r) => setTimeout(r, 1500)); }
    for (const [i, text] of order.entries()) {
      note.textContent = `Playing part ${(i % chunks.length) + 1} of ${chunks.length}${i >= chunks.length ? " (second time)" : ""}. Hold the phones close.`;
      bar.style.width = `${(100 * i) / order.length}%`;
      const s = c.encode(text, speed), buf = ctx.createBuffer(1, s.length, c.sampleRate);
      buf.copyToChannel(s, 0);
      const src = ctx.createBufferSource(); src.buffer = buf; src.connect(ctx.destination);
      await new Promise((r) => { src.onended = r; src.start(); });
      await new Promise((r) => setTimeout(r, 400));
    }
    bar.style.width = "100%";
    note.textContent = "Done. If the other phone did not get it, play again or show the QR code.";
  } catch (e) { note.textContent = `Sound failed: ${e.message}`; }
  btn.disabled = false;
};

$("checkReceipt").onclick = () => {
  const pin = $("gwPub").value.trim();
  if (!pin) return status($("receiptStatus"), "warn", "Add the gateway's public key in Settings first, so the receipt can be checked against it.");
  const r = readReceiptText($("receipt").value, pin);
  if (!r) return status($("receiptStatus"), "bad", "Not a valid receipt from the pinned gateway.");
  const mine = current && r.txid === current.tx.id("hex");
  const kind = r.status === "ACCEPTED" ? "good" : r.status === "VALID_NOT_SENT" ? "warn" : "bad";
  status($("receiptStatus"), kind, `Signed by your gateway: ${r.status} for ${short(r.txid)} at ${new Date(r.time * 1000).toLocaleString()}.${current ? (mine ? " It is this payment." : " It is NOT the payment loaded above.") : ""}`);
};

// ---------- get paid ----------
const outbox = { list() { try { return JSON.parse(store.get("outbox", "[]")); } catch { return []; } }, save(l) { store.set("outbox", JSON.stringify(l)); } };

function received(tx, type, msg) {
  const check = checkOffline(tx), addr = $("myAddr").value.trim(), want = Number($("want").value || 0);
  const rows = [["txid", short(tx.id("hex"))], ["fee", check.ok ? `${check.fee} sat` : "?"]];
  if (!check.ok) { status($("getStatus"), "bad", `Do not accept: ${check.reason}`); summary($("getSummary"), rows); return; }
  if (addr) {
    let pay;
    try { pay = paysAddress(tx, addr, want); } catch { return status($("getStatus"), "bad", "Your address does not look right: check it."); }
    rows.unshift(["to you", `${pay.got} sat`]);
    if (!pay.ok) { status($("getStatus"), "bad", `Signed correctly, but it pays you ${pay.got} sat, not ${want}.`); summary($("getSummary"), rows); return; }
    status($("getStatus"), "good", `Signed correctly and pays you ${pay.got} sat. Not yet broadcast: forward it below. For a large amount, wait for a gateway receipt.`);
  } else status($("getStatus"), "warn", "Signed correctly. Add your address above to check it pays you.");
  summary($("getSummary"), rows);
  const l = outbox.list().filter((x) => x.txid !== tx.id("hex"));
  l.unshift({ txid: tx.id("hex"), text: paymentTexts(type, msg)[0], hex: Buffer.from(tx.toEF()).toString("hex"), at: Date.now() });
  outbox.save(l.slice(0, 50)); renderOutbox();
}

function renderOutbox() {
  const ul = $("outbox"); ul.innerHTML = "";
  const l = outbox.list();
  if (!l.length) { const li = document.createElement("li"); li.className = "muted"; li.textContent = "Nothing waiting."; ul.append(li); return; }
  for (const item of l) {
    const li = document.createElement("li");
    const t = document.createElement("div"); t.textContent = `${short(item.txid)}, ${new Date(item.at).toLocaleString()}`; li.append(t);
    const row = document.createElement("div"); row.className = "row";
    const n = $("gwNumber").value.trim();
    if (n) { const a = document.createElement("a"); a.className = "btn"; a.textContent = "Text to gateway"; a.href = smsHref(n, item.text); row.append(a); }
    const b = document.createElement("button"); b.className = "btn"; b.textContent = "Broadcast now (mainnet)";
    const s = document.createElement("div");
    b.onclick = async () => {
      if (!confirm("Send this payment to Bitcoin BSV mainnet now, through GorillaPool ARC?")) return;
      try {
        const r = await fetch(`${ARC}/v1/tx`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ rawTx: item.hex }) });
        const body = await r.text();
        if (r.ok || /already|known/i.test(body)) { status(s, "good", `Broadcaster accepted it (${r.status}).`); outbox.save(outbox.list().filter((x) => x.txid !== item.txid)); setTimeout(renderOutbox, 1500); }
        else status(s, "bad", `Refused (${r.status}): ${body.slice(0, 160)}`);
      } catch (e) { status(s, "bad", `No connection: ${e.message}. Try again when online, or text it.`); }
    };
    const x = document.createElement("button"); x.className = "btn"; x.textContent = "Remove";
    x.onclick = () => { outbox.save(outbox.list().filter((y) => y.txid !== item.txid)); renderOutbox(); };
    row.append(b, x); li.append(row, s); ul.append(li);
  }
}
renderOutbox();

// ---------- faucets ----------
const heard = new Set();
// a faucet announcement or a bearer coin: show it once, with what can be done. Returns true if handled.
function faucetText(text) {
  const t = String(text ?? "").trim(), ann = parseAnnouncement(t), coin = !ann && parseCoinLine(t);
  if (!ann && !coin) return false;
  if (heard.has(t)) return true;
  heard.add(t);
  const li = document.createElement("li"), row = document.createElement("div"), s = document.createElement("div");
  row.className = "row";
  if (ann) {
    li.textContent = ann.mode === "claims" ? `Faucet ${ann.id}: ${ann.coinSats} sat each, ${ann.left} of ${ann.count} left.` : `Bearer faucet ${ann.id}: coins of ${ann.coinSats} sat. Listen on for the coins themselves.`;
    if (ann.mode === "claims") {
      const send = () => { const a = $("myAddr").value.trim(); if (!a) { status(s, "warn", "Add your address at the top first."); return null; } return claimText(a); };
      if (ann.claimTo && /^\+?[0-9]{5,15}$/.test(ann.claimTo)) {
        const a = document.createElement("a"); a.className = "btn"; a.textContent = "Claim by text"; a.href = "#";
        a.onclick = (e) => { const body = send(); if (!body) { e.preventDefault(); return; } a.href = smsHref(ann.claimTo, body); };
        row.append(a);
      }
      const c = document.createElement("button"); c.className = "btn"; c.textContent = "Copy claim text";
      c.onclick = async () => { const body = send(); if (!body) return; try { await navigator.clipboard.writeText(body); status(s, "good", `Copied: ${body}`); } catch { prompt("Send this to the faucet:", body); } };
      row.append(c);
    }
  } else {
    li.textContent = `Bearer coin ${coin.i}: ${coin.sats} sat, heard ${new Date().toLocaleTimeString()}.`;
    const b = document.createElement("button"); b.className = "btn primary"; b.textContent = "Sweep to my address";
    b.onclick = async () => {
      const a = $("myAddr").value.trim();
      if (!a) return status(s, "warn", "Add your address at the top first.");
      try {
        const tx = await sweepCoinLine(t, a);
        received(tx, TYPE.PAY_EF, encodePayment(tx).msg);
        status(s, "good", `Signed over to you: ${tx.outputs[0].satoshis} sat. It is in "Waiting to be sent": forward it soon, since anyone else who heard this coin can try too.`);
        b.disabled = true;
      } catch (e) { status(s, "bad", e.message); }
    };
    row.append(b);
  }
  li.append(row, s);
  $("faucets").prepend(li);
  return true;
}

$("getLoad").onclick = () => {
  for (const line of $("getPaste").value.split(/\n+/)) if (faucetText(line)) { status($("getStatus"), "good", "Faucet text added below."); return; }
 try { const { tx, type } = readPayment($("getPaste").value); received(tx, type, encodePayment(tx, { beef: type === TYPE.PAY_BEEF }).msg); } catch (e) { status($("getStatus"), "bad", e.message); } };

let stopper = null;
function stopAll() { stopper?.(); stopper = null; $("stop").classList.add("hidden"); $("video").classList.add("hidden"); $("listenNote").classList.add("hidden"); }
$("stop").onclick = stopAll;

$("scan").onclick = async () => {
  stopAll();
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" } });
    const video = $("video"); video.srcObject = stream; video.classList.remove("hidden"); $("stop").classList.remove("hidden");
    await video.play();
    const detector = "BarcodeDetector" in window ? new window.BarcodeDetector({ formats: ["qr_code"] }) : null;
    const canvas = document.createElement("canvas"), g = canvas.getContext("2d", { willReadFrequently: true });
    const parts = textAssembler(); let live = true, seen = new Set();
    stopper = () => { live = false; stream.getTracks().forEach((t) => t.stop()); };
    status($("getStatus"), "warn", "Point the camera at the payer's QR code.");
    const tick = async () => {
      if (!live) return;
      let text = null;
      if (video.videoWidth) {
        if (detector) { const codes = await detector.detect(video).catch(() => []); text = codes[0]?.rawValue ?? null; }
        else { canvas.width = video.videoWidth; canvas.height = video.videoHeight; g.drawImage(video, 0, 0); const img = g.getImageData(0, 0, canvas.width, canvas.height); text = jsQR(img.data, img.width, img.height)?.data ?? null; }
      }
      if (text && !seen.has(text) && faucetText(text)) { seen.add(text); status($("getStatus"), "good", "Faucet code scanned: see below."); }
      const p = text && parseText(text);
      if (p && !seen.has(text)) {
        seen.add(text);
        const whole = parts.add("qr", p);
        if (whole?.msg) { stopAll(); return received(decodePayment(whole.type, whole.msg), whole.type, whole.msg); }
        if (whole?.corrupt) status($("getStatus"), "bad", "The codes did not fit together. Scan again.");
        else if (p.of) status($("getStatus"), "warn", `Got code ${p.part} of ${p.of}. Keep scanning.`);
      }
      requestAnimationFrame(tick);
    };
    tick();
  } catch (e) { status($("getStatus"), "bad", `Camera unavailable: ${e.message}`); stopAll(); }
};

$("listen").onclick = async () => {
  stopAll();
  try {
    const c = await codec(), ctx = audioCtx();
    await ctx.resume();
    const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false } });
    const src = ctx.createMediaStreamSource(stream), proc = ctx.createScriptProcessor(4096, 1, 1), sink = ctx.createGain();
    sink.gain.value = 0; // keep the node running without playing the microphone back
    const asm = soundAssembler(), note = $("listenNote");
    note.textContent = "Listening. Hold this phone close to the payer's speaker."; note.classList.remove("hidden"); $("stop").classList.remove("hidden");
    proc.onaudioprocess = (ev) => {
      for (const text of c.decode(new Float32Array(ev.inputBuffer.getChannelData(0)))) {
        if (faucetText(text)) { note.textContent = "Heard a faucet message: see Faucets heard."; continue; }
        const p = parseChunk(text); if (!p) continue;
        const r = asm.add(p);
        if (r.msg) { stopAll(); received(decodePayment(r.type, r.msg), r.type, r.msg); return; }
        note.textContent = r.corrupt ? "Parts did not fit together. Ask the payer to play again." : `Heard part ${r.have} of ${r.of}...`;
      }
    };
    src.connect(proc); proc.connect(sink); sink.connect(ctx.destination);
    stopper = () => { proc.disconnect(); src.disconnect(); stream.getTracks().forEach((t) => t.stop()); };
  } catch (e) { status($("getStatus"), "bad", `Microphone unavailable: ${e.message}`); stopAll(); }
};

// for checks from the browser console (and the built-in browser test)
window.handoff = { faucetText, readPayment, setPayment, received, current: () => current, jsQR, codec, soundChunks, parseChunk, soundAssembler, parseText };
