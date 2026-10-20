// The phone page: hand a signed Bitcoin BSV payment over with no internet (QR code, sound, or a
// text to an SMS gateway), check it offline on the receiving phone, and check the gateway's
// signed receipt. Uses radio/lib and radio/sms unchanged, so it checks exactly what the gateway
// checks.
import qrcode from "qrcode-generator";
import jsQR from "jsqr";
import ggwaveFactory from "ggwave";
import { PrivateKey, Transaction, P2PKH, Utils } from "@bsv/sdk";
import { TYPE } from "../../lib/frame.mjs";
import { encodePayment, decodePayment, checkOffline, paysAddress, buildRadioPayment, demoPayment } from "../../lib/payment.mjs";
import { paymentTexts, parseText, textAssembler, readReceiptText } from "../../sms/text.mjs";
import { soundChunks, parseChunk, soundAssembler, ggwaveCodec, QUIET } from "../../lib/sound.mjs";
import { parseAnnouncement, parseCoinLine, sweepCoinLine, claimText } from "../../faucet/faucet.mjs";
import { importWallet, fetchCoins, buildFromCoins } from "../../lib/wallet.mjs";
import { arcVerdict } from "../../../agent/lib/arc.mjs";

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

// "1Abc...: 1000 sat" for each output, so a payment says plainly where it goes
function paysList(tx) {
  return tx.outputs.map((o) => {
    const h = o.lockingScript.toHex(), m = h.match(/^76a914([0-9a-f]{40})88ac$/);
    const who = m ? Utils.toBase58Check(Utils.toArray(m[1], "hex"), [0]) : /^(00)?6a/.test(h) ? "a data note" : "another kind of script";
    return `${who}: ${o.satoshis} sat`;
  });
}
async function broadcastEF(efHex) {
  const r = await fetch(`${ARC}/v1/tx`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ rawTx: efHex }) });
  const body = await r.text();
  const v = arcVerdict(r.status, body); // ARC can answer 200 for a payment that will never be mined
  return { ok: v.ok, status: v.txStatus ?? r.status, why: v.why, body };
}
function txLink(el, kind, text, txid) {
  status(el, kind, text);
  const a = document.createElement("a"); a.href = `https://whatsonchain.com/tx/${txid}`; a.target = "_blank"; a.rel = "noopener noreferrer"; a.textContent = " See it on WhatsOnChain"; const note = document.createElement("span"); note.textContent = " (it can take a minute to appear there: if it says not found, refresh).";
  el.firstChild.append(a, note);
}

function status(el, kind, text) { el.innerHTML = ""; const d = document.createElement("div"); d.className = `status ${kind}`; d.textContent = text; el.append(d); }
const DT_TERMS = { txid: "txid", pays: "pays", fee: "fee", size: "size", "to you": "toyou" };
function summary(el, rows) { el.innerHTML = ""; for (const [k, v] of rows) { const dt = document.createElement("dt");
  if (DT_TERMS[k]) { const t = document.createElement("span"); t.className = "tip"; t.tabIndex = 0; t.dataset.term = DT_TERMS[k]; t.textContent = k; dt.append(t); } else dt.textContent = k; const dd = document.createElement("dd"); dd.textContent = v; el.append(dt, dd); } el.classList.remove("hidden"); }

// ---------- plain-words tips: point at a dotted word, or tap it on a phone ----------
const GLOSS = {
  signed: "A payment your wallet has approved with its key. Anyone can check it is genuine, but no money moves until it is broadcast.",
  ef: "Two standard ways to write a signed Bitcoin BSV payment as text. Both carry what is needed to check it with no internet; BEEF can also carry proof that the coins exist.",
  bsv1: "This page's own text form of a payment, starting with BSV1. You can paste it, show it as a QR code, or send it by text message.",
  wif: "WIF (wallet import format) is the usual way to write a private key: about 52 letters and numbers starting with K, L or 5. Whoever has it can spend the coins, so keep it secret.",
  phrase: "12 to 24 ordinary words that rebuild your wallet's keys. Anyone with them can take your coins. Never share them or type them into a site you do not trust.",
  coins: "The separate amounts your address holds. A payment spends one or more of them, and any change comes back to you as a new one.",
  funding: "An earlier payment into your address, as raw text. Saved while you were online, it lets this page spend that money with no internet.",
  address: "Where BSV is sent, like an account number. Safe to share. It starts with 1.",
  sat: "Satoshis (sat) are the smallest unit of Bitcoin BSV. 100,000,000 sat is 1 BSV.",
  gateway: "A phone or computer that is online and receives payments by text message, sends them to the network for you, and texts back a receipt.",
  receipt: "The gateway's signed reply saying what it did with your payment. ACCEPTED means the network took it.",
  pinned: "The gateway's public key, given to you by whoever runs it. The page uses it to check that a receipt really came from that gateway and not from someone pretending.",
  faucet: "Someone giving away small amounts of BSV, announced over sound, radio or text. You claim a share by sending your address.",
  bearer: "A coin whose key is announced openly. Whoever moves it to their own address first keeps it.",
  outbox: "Payments you accepted that have not reached the network yet. Forward each one (by text or Broadcast now) when you can: until then it is not final.",
  webrtc: "A standard way for two browsers to talk to each other directly. Here it only uses your local network: no server sees the payment.",
  dualtone: "Lower, slower sounds that still get through a walkie-talkie, AM radio or a phone call, which cut off the higher tones.",
  txid: "Transaction ID: the payment's unique reference. Use it to look the payment up on WhatsOnChain.",
  pays: "Every address this payment sends money to, and how much. Change going back to the payer is listed too.",
  fee: "A small amount paid to the network to process the payment.",
  size: "How big the payment is as data. Smaller is quicker to send by sound or radio.",
  toyou: "How much of this payment goes to the address you entered above.",
};
const tipBox = $("tipBox");
let tipFor = null;
function showTip(el) {
  const text = GLOSS[el.dataset.term];
  if (!text) return;
  tipFor = el; tipBox.textContent = text; tipBox.classList.remove("hidden");
  const r = el.getBoundingClientRect(), w = tipBox.offsetWidth;
  const left = Math.min(Math.max(8, r.left + window.scrollX), window.scrollX + document.documentElement.clientWidth - w - 8);
  tipBox.style.left = `${left}px`;
  tipBox.style.top = `${r.bottom + window.scrollY + 6}px`;
}
function hideTip() { tipFor = null; tipBox.classList.add("hidden"); }
function initTips(root = document) {
  for (const el of root.querySelectorAll(".tip:not([data-tip-ready])")) {
    el.dataset.tipReady = "1";
    el.setAttribute("aria-label", `${el.textContent}: ${GLOSS[el.dataset.term] ?? ""}`);
    el.addEventListener("mouseenter", () => showTip(el));
    el.addEventListener("mouseleave", () => { if (tipFor === el) hideTip(); });
    el.addEventListener("focus", () => showTip(el));
    el.addEventListener("blur", () => { if (tipFor === el) hideTip(); });
    // a tap on a phone: show it, and do not let a label around it move focus to the field
    el.addEventListener("click", (e) => { e.preventDefault(); e.stopPropagation(); if (tipFor === el && e.pointerType !== "mouse") hideTip(); else showTip(el); });
  }
}
document.addEventListener("click", (e) => { if (tipFor && !e.target.closest(".tip")) hideTip(); });
document.addEventListener("keydown", (e) => { if (e.key === "Escape") hideTip(); });
addEventListener("resize", hideTip);
initTips();
new MutationObserver(() => initTips()).observe(document.body, { childList: true, subtree: true });

// ---------- tabs and settings ----------
for (const b of document.querySelectorAll("[data-tab]")) b.onclick = () => {
  for (const x of document.querySelectorAll("[data-tab]")) x.setAttribute("aria-selected", String(x === b));
  for (const p of document.querySelectorAll("[data-panel]")) p.classList.toggle("hidden", p.dataset.panel !== b.dataset.tab);
};
// links inside the guide switch tabs; the guide remembers being closed
for (const b of document.querySelectorAll("[data-goto]")) b.onclick = () => { document.querySelector(`[data-tab="${b.dataset.goto}"]`).click(); document.querySelector(".tabs").scrollIntoView({ behavior: "smooth" }); };
const guide = $("guide");
if (store.get("guideClosed") === "1") guide.open = false;
guide.ontoggle = () => store.set("guideClosed", guide.open ? "0" : "1");
for (const id of ["gwNumber", "gwPub", "speed", "myAddr", "want"]) { const el = $(id); el.value = store.get(id, el.value); el.onchange = () => { store.set(id, el.value.trim()); refreshSms(); }; }

// ---------- ggwave, loaded once ----------
let codecPromise = null, audio = null;
function audioCtx() { audio ??= new (window.AudioContext || window.webkitAudioContext)(); return audio; }
const codec = () => (codecPromise ??= ggwaveFactory(QUIET).then((gg) => ggwaveCodec(gg, { inputRate: audioCtx().sampleRate })));

// ---------- pay ----------
let current = null; // { tx, type, msg, text }

function setPayment(tx, type) {
  const { msg } = type === TYPE.PAY_BEEF ? encodePayment(tx, { beef: true }) : encodePayment(tx);
  const check = checkOffline(tx);
  const text = paymentTexts(type, msg)[0];
  current = { tx, type, msg, text, check };
  if (check.ok) status($("payStatus"), "good", "Signed correctly. Ready to give to the other person.");
  else status($("payStatus"), "bad", `This payment does not check out: ${check.reason}`);
  summary($("paySummary"), [["txid", short(tx.id("hex"))], ["pays", paysList(tx).join("\n")], ["fee", check.ok ? `${check.fee} sat` : "?"], ["size", `${msg.length} bytes, ${type === TYPE.PAY_BEEF ? "BEEF" : "EF"}`]]);
  for (const id of ["showQr", "play", "copy", "broadcastPay"]) $(id).disabled = !check.ok;
  $("handStatus").innerHTML = "";
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
  const to = peerAddr || PrivateKey.fromRandom().toAddress();
  const { tx } = await demoPayment({ to, sats: 1000 });
  setPayment(tx, TYPE.PAY_EF);
  status($("payStatus"), "warn", "Demo payment: signed correctly, but its funding is made up, so a gateway can check it and the network would refuse it.");
  $("broadcastPay").disabled = true; $("broadcastPay").title = "A demo payment cannot be sent: its funding is made up.";
};
$("load").onclick = () => { try { const { tx, type } = readPayment($("paste").value); setPayment(tx, type); } catch (e) { status($("payStatus"), "bad", e.message); } };
// ---------- send real BSV: a wallet held in memory only ----------
let wallet = null, coins = [];
const sumSats = () => coins.reduce((n, c) => n + c.sats, 0);
function showCoins() { setTimeout(wRender, 0); showCoinsText(); }
function showCoinsText() { status($("coinsStatus"), coins.length ? "good" : "warn", coins.length ? `${coins.length} coin${coins.length > 1 ? "s" : ""}, ${sumSats()} sat ready to spend.` : "No coins found for this address."); }
function setWallet(w, { quiet = false } = {}) {
  wallet = w; coins = [];
  if (w) { session.unlock(w.key.toWif()); session.remember(w.address); }
  setTimeout(() => { try { sendHello(); } catch {} }, 0);
  setTimeout(wRender, 0);
  $("walletIn").value = "";
  $("coinsBox").classList.toggle("hidden", !w);
  $("walletForget").classList.toggle("hidden", !w);
  $("coinsStatus").innerHTML = "";
  if (!w) { $("walletStatus").innerHTML = ""; return; }
  if (!quiet) status($("walletStatus"), "good", `Wallet loaded from a ${w.kind}: ${w.address}`);
  else status($("walletStatus"), "good", `Wallet open in this tab: ${w.address}`);
  if (!$("myAddr").value.trim()) { $("myAddr").value = w.address; store.set("myAddr", w.address); }
}
$("walletLoad").onclick = () => {
  const r = session.remembered();
  if (!$("walletIn").value.trim() && !wallet && r) return status($("walletStatus"), "warn", `This tab is locked: it remembers your address (${r.address.slice(0, 6)}...${r.address.slice(-4)}) but not your key. The key stays only in the browser tab where you opened it, and locks after ${session.IDLE_MINUTES} minutes without use. Use that tab, or load your key or recovery phrase here once. (For a test, Try a demo payment needs no wallet.)`);
  try { setWallet(importWallet($("walletIn").value)); } catch (e) { status($("walletStatus"), "bad", e.message); }
};
$("walletIn").onkeydown = (e) => { if (e.key === "Enter") $("walletLoad").click(); };
$("walletFile").onchange = async (e) => {
  const f = e.target.files[0]; e.target.value = "";
  if (!f) return;
  try { setWallet(importWallet(await f.text())); } catch (err) { status($("walletStatus"), "bad", err.message); }
};
$("walletForget").onclick = () => { session.lock(); setWallet(null); status($("walletStatus"), "good", "Wallet closed in this tab. Its address is still shown at the top until you choose Close wallet there."); };
$("coinsGet").onclick = async () => {
  const b = $("coinsGet"); b.disabled = true; status($("coinsStatus"), "warn", "Asking WhatsOnChain for your coins...");
  try { coins = await fetchCoins(wallet.address); showCoins(); }
  catch (e) { status($("coinsStatus"), "bad", `${e.message}. With no internet, paste a funding transaction instead.`); }
  b.disabled = false;
};
$("fundAdd").onclick = () => {
  try {
    const tx = Transaction.fromHex($("fund").value.trim()), mine = new P2PKH().lock(wallet.address).toHex();
    const found = tx.outputs.map((o, vout) => ({ tx, vout, sats: o.satoshis, mine: o.lockingScript.toHex() === mine })).filter((c) => c.mine);
    if (!found.length) throw new Error(`that transaction does not pay ${wallet.address}`);
    for (const c of found) if (!coins.some((x) => x.tx.id("hex") === tx.id("hex") && x.vout === c.vout)) coins.push({ tx, vout: c.vout, sats: c.sats });
    $("fund").value = ""; showCoins();
  } catch (e) { status($("coinsStatus"), "bad", e.message); }
};
$("sign").onclick = async () => {
  try {
    if (!coins.length) throw new Error("get your coins first (or paste a funding transaction)");
    const to = $("to").value.trim(), sats = Number($("sats").value);
    const tx = await buildFromCoins({ key: wallet.key, coins, to, sats });
    // the coins it spends are gone; its change is a new coin for the next payment
    const spent = new Set(tx.inputs.map((i) => `${i.sourceTransaction.id("hex")}:${i.sourceOutputIndex}`));
    coins = coins.filter((c) => !spent.has(`${c.tx.id("hex")}:${c.vout}`));
    tx.outputs.forEach((o, vout) => { if (vout > 0) coins.push({ tx, vout, sats: o.satoshis }); });
    setPayment(tx, TYPE.PAY_EF);
    status($("payStatus"), "good", `Signed: ${sats} sat to ${to}. Give it to the other person below. Nothing is sent until someone forwards or broadcasts it.`);
    showCoins();
  } catch (e) { status($("payStatus"), "bad", e.message); }
};
$("broadcastPay").onclick = async () => {
  const txid = current.tx.id("hex"), b = $("broadcastPay");
  if (!confirm(`Send this payment to Bitcoin BSV mainnet now?\n\n${paysList(current.tx).join("\n")}\n\nOnce sent it cannot be undone.`)) return;
  b.disabled = true; status($("handStatus"), "warn", "Sending...");
  try {
    const r = await broadcastEF(Buffer.from(current.tx.toEF()).toString("hex"));
    if (r.ok) txLink($("handStatus"), "good", `Sent: the network accepted it (${r.status}).`, txid);
    else { status($("handStatus"), "bad", `Not sent: ${r.why}.`); b.disabled = false; }
  } catch (e) { status($("handStatus"), "bad", `No connection: ${e.message}. Give it to the other person instead, or try again when online.`); b.disabled = false; }
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
// QR codes are links to this page with the payment after "#pay=", so a phone's own camera app
// opens the page with the payment loaded. The part after "#" never leaves the phone: browsers do
// not send it to the server. The page's own scanner reads both links and bare text.
const LINK_BASE = /^https?:$/.test(location.protocol) ? location.origin + location.pathname : "https://dtn.bsvkey.com/radio/";
const asLink = (t) => `${LINK_BASE}#pay=${encodeURIComponent(t)}`;
const fromLink = (t) => { const m = String(t ?? "").match(/#pay=([^#]+)$/); if (!m) return t; try { return decodeURIComponent(m[1]); } catch { return t; } };

$("showQr").onclick = () => {
  clearInterval(qrTimer);
  const parts = current.text.length <= QR_SINGLE_MAX ? [current.text] : paymentTexts(current.type, current.msg, { maxChars: 600 });
  let i = 0;
  const show = () => { drawQr(asLink(parts[i])); $("qrNote").textContent = parts.length > 1 ? `Code ${i + 1} of ${parts.length}: keep scanning until all are in` : "Let the other phone scan this"; i = (i + 1) % parts.length; };
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

let lastReceived = null;
function received(tx, type, msg) {
  const check = checkOffline(tx), addr = $("myAddr").value.trim(), want = Number($("want").value || 0);
  const rows = [["pays", paysList(tx).join("\n")], ["txid", short(tx.id("hex"))], ["fee", check.ok ? `${check.fee} sat` : "?"]];
  lastReceived = { tx, type, msg };
  $("forwardRow").classList.add("hidden");
  if (!check.ok) { status($("getStatus"), "bad", `Do not accept: ${check.reason}`); summary($("getSummary"), rows); return; }
  if (addr) {
    let pay;
    try { pay = paysAddress(tx, addr, want); } catch { return status($("getStatus"), "bad", "Your address does not look right: check it."); }
    rows.unshift(["to you", `${pay.got} sat`]);
    if (!pay.ok || pay.got === 0) {
      status($("getStatus"), "bad", pay.got ? `Signed correctly, but it pays you ${pay.got} sat, not ${want}.` : `Signed correctly, but it does not pay your address ${addr}. See "pays" below for where it goes. If you are carrying it for someone (or it sets up a faucet), press "Keep it to forward anyway", then Broadcast now under "Waiting to be sent".`);
      summary($("getSummary"), rows);
      $("forwardRow").classList.remove("hidden"); // a courier can still carry someone else's payment to the network
      return;
    }
    status($("getStatus"), "good", `Signed correctly and pays you ${pay.got} sat. Not yet broadcast: forward it below. For a large amount, wait for a gateway receipt.`);
  } else status($("getStatus"), "warn", "Signed correctly. Add your address above to check it pays you.");
  summary($("getSummary"), rows);
  addToOutbox(tx, type, msg);
}
function addToOutbox(tx, type, msg) {
  const old = outbox.list().find((x) => x.txid === tx.id("hex"));
  const l = outbox.list().filter((x) => x.txid !== tx.id("hex"));
  l.unshift({ txid: tx.id("hex"), text: paymentTexts(type, msg)[0], hex: Buffer.from(tx.toEF()).toString("hex"), at: old?.at ?? Date.now(), ...(old?.sentAt ? { sentAt: old.sentAt } : {}) });
  outbox.save(l.slice(0, 50)); renderOutbox();
}
$("forwardAnyway").onclick = () => {
  if (!lastReceived) return;
  addToOutbox(lastReceived.tx, lastReceived.type, lastReceived.msg);
  $("forwardRow").classList.add("hidden");
  status($("getStatus"), "good", "Kept in \"Waiting to be sent\" below. It pays someone else: you are only carrying it. Press Broadcast now there to send it to the network.");
  $("outbox").scrollIntoView({ behavior: "smooth", block: "center" });
};

function renderOutbox() {
  const ul = $("outbox"); ul.innerHTML = "";
  const l = outbox.list();
  if (!l.length) { const li = document.createElement("li"); li.className = "muted"; li.textContent = "Nothing waiting."; ul.append(li); return; }
  for (const item of l) {
    const li = document.createElement("li");
    const t = document.createElement("div"); t.textContent = `${short(item.txid)}, ${new Date(item.at).toLocaleString()}`; li.append(t);
    const row = document.createElement("div"); row.className = "row";
    const s = document.createElement("div");
    const x = document.createElement("button"); x.className = "btn"; x.textContent = item.sentAt ? "Remove from list" : "Remove";
    x.onclick = () => { outbox.save(outbox.list().filter((y) => y.txid !== item.txid)); renderOutbox(); };
    if (item.sentAt) {
      // sent: keep it here with its link until the person removes it
      txLink(s, "good", `Sent to the network ${new Date(item.sentAt).toLocaleString()}.`, item.txid);
      row.append(x); li.append(s, row); ul.append(li);
      continue;
    }
    const n = $("gwNumber").value.trim();
    if (n) { const a = document.createElement("a"); a.className = "btn"; a.textContent = "Text to gateway"; a.href = smsHref(n, item.text); row.append(a); }
    const b = document.createElement("button"); b.className = "btn"; b.textContent = "Broadcast now (mainnet)";
    b.onclick = async () => {
      if (!confirm("Send this payment to Bitcoin BSV mainnet now, through GorillaPool ARC?")) return;
      b.disabled = true; status(s, "warn", "Sending...");
      try {
        const r = await broadcastEF(item.hex);
        if (r.ok) { outbox.save(outbox.list().map((x) => (x.txid === item.txid ? { ...x, sentAt: Date.now() } : x))); renderOutbox(); }
        else { status(s, "bad", `Not sent: ${r.why}.`); b.disabled = false; }
      } catch (e) { status(s, "bad", `No connection: ${e.message}. Try again when online, or text it.`); b.disabled = false; }
    };
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
        // straight to the outbox: the expected-amount box is for payments from people, not coins
        addToOutbox(tx, TYPE.PAY_EF, encodePayment(tx).msg);
        status(s, "good", `Signed over to you: ${tx.outputs[0].satoshis} sat. Now press Broadcast now under "Waiting to be sent" below, soon: anyone else who heard this coin can try too.`);
        $("outbox").scrollIntoView({ behavior: "smooth", block: "center" });
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

// what to do when the browser will not hand over the camera or microphone
function mediaError(what, e) {
  if (e.name === "NotAllowedError") return `The ${what} was not allowed. Press the button again and choose Allow, or allow it from the icon at the left of the address bar.`;
  if (e.name === "NotFoundError" || e.name === "OverconstrainedError") return `No ${what} was found on this device.`;
  if (e.name === "NotReadableError") return `The ${what} is in use by another app or tab. Close that, then try again.`;
  if (!window.isSecureContext) return `The ${what} only works when this page is opened over https.`;
  return `The ${what} is unavailable: ${e.message}`;
}

const listenStats = {}; // for diagnosing: audio received vs time, and time spent decoding
let stopper = null;
function stopAll() { stopper?.(); stopper = null; $("stop").classList.add("hidden"); $("video").classList.add("hidden"); $("listenNote").classList.add("hidden"); $("micMeter").classList.add("hidden"); }
$("stop").onclick = stopAll;

$("scan").onclick = async () => {
  stopAll();
  try {
    $("getStatus").innerHTML = "";
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
      if (text) text = fromLink(text);
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
  } catch (e) { status($("getStatus"), "bad", mediaError("camera", e)); stopAll(); }
};

$("listen").onclick = async () => {
  stopAll();
  try {
    const c = await codec(), ctx = audioCtx();
    await ctx.resume();
    const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false } });
    const src = ctx.createMediaStreamSource(stream), proc = ctx.createScriptProcessor(4096, 1, 1), sink = ctx.createGain();
    sink.gain.value = 0; // keep the node running without playing the microphone back
    const asm = soundAssembler(), note = $("listenNote"), meter = $("micMeter"), bar = meter.firstElementChild;
    const track = stream.getAudioTracks()[0];
    note.textContent = `Listening on "${track?.label || "microphone"}". Hold this device close to the payer's speaker.`;
    note.classList.remove("hidden"); meter.classList.remove("hidden"); $("stop").classList.remove("hidden");
    $("getStatus").innerHTML = "";
    // a level bar and plain hints: is the microphone hearing anything, and is it hearing a payment?
    const started = Date.now();
    let loudSince = 0, quietFor = 0, heardAny = false, hinted = "";
    const hint = (k, t) => { if (hinted !== k) { hinted = k; status($("getStatus"), "warn", t); } };
    listenStats.started = performance.now(); listenStats.samples = 0; listenStats.decodeMs = 0; listenStats.rate = ctx.sampleRate;
    proc.onaudioprocess = (ev) => {
      const block = ev.inputBuffer.getChannelData(0);
      listenStats.samples += block.length;
      let sum = 0;
      for (let i = 0; i < block.length; i++) sum += block[i] * block[i];
      const rms = Math.sqrt(sum / block.length), level = Math.min(100, Math.round(Math.sqrt(rms) * 220));
      bar.style.width = `${level}%`;
      if (rms < 0.0005) quietFor += block.length / ctx.sampleRate; else { quietFor = 0; if (!loudSince && rms > 0.01) loudSince = Date.now(); }
      if (!heardAny && quietFor > 4) hint("silent", "The microphone is hearing nothing. Check it is not muted, and that the right microphone is chosen (the microphone icon in the address bar, or your system sound settings).");
      else if (!heardAny && loudSince && Date.now() - loudSince > 35000) hint("noise", "Hearing sound, but no payment yet. Turn the payer's volume up, hold the devices closer, or on a walkie-talkie use the walkie-talkie setting on both sides. Two windows on one computer often do not work, because the computer filters out its own speaker: use two devices.");
      else if (!heardAny && Date.now() - started > 6000 && quietFor === 0 && hinted === "silent") { hinted = ""; $("getStatus").innerHTML = ""; }
      const t0 = performance.now(), texts = c.decode(new Float32Array(block)); listenStats.decodeMs += performance.now() - t0;
      for (const text of texts) {
        heardAny = true; if (hinted) { hinted = ""; $("getStatus").innerHTML = ""; }
        if (faucetText(text)) { note.textContent = "Heard a faucet message: see Faucets heard."; continue; }
        const p = parseChunk(text); if (!p) continue;
        const r = asm.add(p);
        if (r.msg) { stopAll(); received(decodePayment(r.type, r.msg), r.type, r.msg); return; }
        note.textContent = r.corrupt ? "Parts did not fit together. Ask the payer to play again." : `Heard part ${r.have} of ${r.of}...`;
      }
    };
    src.connect(proc); proc.connect(sink); sink.connect(ctx.destination);
    stopper = () => { proc.disconnect(); src.disconnect(); stream.getTracks().forEach((t) => t.stop()); };
  } catch (e) { status($("getStatus"), "bad", mediaError("microphone", e)); stopAll(); }
};

// ---------- Open wallet: the top bar, as on bsvkey.com ----------
// Same rules as bsvkey.com's wallet-session.js, on this site (dtn.bsvkey.com is a different site,
// so a wallet opened on bsvkey.com cannot be seen here, and the other way round):
//   remembered (localStorage): the address only, to show who you are; it cannot spend.
//   unlocked (sessionStorage, this tab only): the key, so a reload does not ask again. It is
//   removed on Lock or Close wallet, when the tab closes, and after 15 minutes without a click or
//   key press. A recovery phrase is never stored: only the key derived from it.
const session = (() => {
  const ADDR = "bsvkey_session_addr", TAB = "bsvkey_session_tab", SEEN = "bsvkey_session_seen", IDLE_MS = 15 * 60 * 1000;
  const ls = { get: (k) => { try { return JSON.parse(localStorage.getItem(k) || "null"); } catch { return null; } }, set: (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} }, del: (k) => { try { localStorage.removeItem(k); } catch {} } };
  const ss = { get: (k) => { try { return JSON.parse(sessionStorage.getItem(k) || "null"); } catch { return null; } }, set: (k, v) => { try { sessionStorage.setItem(k, JSON.stringify(v)); } catch {} }, del: (k) => { try { sessionStorage.removeItem(k); } catch {} } };
  const fns = new Set();
  let chan = null; try { chan = new BroadcastChannel("bsvkey-session"); } catch {}
  const runLock = (why) => { ss.del(TAB); ss.del(SEEN); for (const f of fns) { try { f(why); } catch {} } };
  const idle = () => { const t = ss.get(SEEN); return !t || Date.now() - t > IDLE_MS; };
  let last = 0;
  const touch = () => { const now = Date.now(); if (now - last < 5000 || !ss.get(TAB)) return; last = now; ss.set(SEEN, now); };
  for (const ev of ["pointerdown", "keydown", "wheel", "touchstart"]) addEventListener(ev, touch, { passive: true, capture: true });
  setInterval(() => { if (ss.get(TAB) && idle()) runLock("idle"); }, 20000);
  if (chan) chan.onmessage = (e) => { const m = e.data || {}; if (m.t === "lock") runLock("elsewhere"); if (m.t === "forget") runLock("forget"); };
  return {
    IDLE_MINUTES: IDLE_MS / 60000,
    remember(address) { ls.set(ADDR, { address, network: "main", at: Date.now() }); },
    remembered() { const r = ls.get(ADDR); return r && typeof r.address === "string" ? r : null; },
    unlock(wif) { ss.set(TAB, { wif, network: "main" }); ss.set(SEEN, Date.now()); last = Date.now(); },
    unlocked() { const t = ss.get(TAB); if (!t || typeof t.wif !== "string") return null; if (idle()) { runLock("idle"); return null; } return t; },
    lock() { runLock("lock"); try { chan?.postMessage({ t: "lock" }); } catch {} },
    forget() { ls.del(ADDR); runLock("forget"); try { chan?.postMessage({ t: "forget" }); } catch {} },
    onLock(f) { fns.add(f); },
  };
})();

function wRender() {
  const btn = $("wBtn"), t = $("hdrWallet"), r = session.remembered();
  const cut = (a) => `${a.slice(0, 6)}...${a.slice(-4)}`;
  if (wallet) { t.textContent = cut(wallet.address) + (coins.length ? ` · ${sumSats().toLocaleString()} sat` : ""); btn.classList.add("on"); btn.title = `Wallet ${wallet.address}, open in this tab only`; }
  else if (r) { t.textContent = `\u{1F512} ${cut(r.address)}`; btn.classList.remove("on"); btn.title = "Locked: load your key again to sign. The address is only shown, it cannot spend."; }
  else { t.textContent = "Open wallet"; btn.classList.remove("on"); btn.title = "Open a wallet: your key never leaves this tab"; }
}
function wItem(label, sub, fn) {
  const b = document.createElement("button"); b.type = "button"; b.setAttribute("role", "menuitem");
  b.textContent = label;
  if (sub) { const sm = document.createElement("small"); sm.textContent = sub; b.append(sm); }
  b.onclick = (e) => { e.stopPropagation(); wMenu(false); fn(); };
  return b;
}
function wReveal(focusId) {
  document.querySelector('[data-tab="pay"]').click();
  $("real").open = true;
  $("real").scrollIntoView({ behavior: "smooth", block: "start" });
  if (focusId) setTimeout(() => { try { $(focusId).focus({ preventScroll: true }); } catch {} }, 400);
}
function wMenu(open) {
  const m = $("wMenu"), btn = $("wBtn");
  if (open == null) open = m.hidden;
  m.hidden = !open; btn.setAttribute("aria-expanded", String(open));
  if (!open) return;
  m.replaceChildren();
  const r = session.remembered();
  if (wallet) m.append(
    wItem("Copy address", wallet.address, () => { navigator.clipboard?.writeText(wallet.address); }),
    wItem(coins.length ? `Coins: ${sumSats().toLocaleString()} sat` : "Get my coins", "Reads your balance from WhatsOnChain (needs internet)", () => { wReveal(); $("coinsGet").click(); }),
    wItem("Send real BSV", "Pay an address from this wallet", () => wReveal("to")),
    wItem("Lock", "Removes the key from this tab (and other open tabs of this page). The address stays shown.", () => { session.lock(); }),
    wItem("Close wallet", "Removes the key and forgets the address on this device. Keep your own copy of the key.", () => {
      if (!confirm("Close this wallet?\n\nThis clears the key from this tab and forgets the address on this device. Make sure you have your key or recovery phrase saved somewhere else.")) return;
      session.forget();
    }));
  else {
    if (r) m.append(
      wItem(`Unlock ${r.address.slice(0, 6)}...${r.address.slice(-4)}`, "Load the key file again, or type the key or recovery phrase", () => wReveal("walletIn")),
      wItem("Forget this address", "Stop showing it on this device", () => { session.forget(); }));
    m.append(
      wItem("Load key file", "A wallet or key file you saved from BSVKey", () => { wReveal(); $("walletFile").click(); }),
      wItem("Recovery phrase or private key", "Type or paste it under Send real BSV", () => wReveal("walletIn")));
  }
  const n = document.createElement("div"); n.className = "wnote";
  n.textContent = `Opening a wallet is not a login: there is no account. A key you load stays unlocked in this browser tab, also after a reload, and locks itself after ${session.IDLE_MINUTES} minutes without use. A recovery phrase is never stored. A wallet opened on bsvkey.com is not shared with this site.`;
  m.append(n);
}
$("wBtn").onclick = (e) => { e.stopPropagation(); wMenu(); };
document.addEventListener("click", (e) => { const m = $("wMenu"); if (!m.hidden && !m.contains(e.target)) wMenu(false); });
document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !$("wMenu").hidden) { wMenu(false); $("wBtn").focus(); } });
session.onLock((why) => {
  if (wallet) { wallet = null; coins = []; $("coinsBox").classList.add("hidden"); $("walletForget").classList.add("hidden"); $("coinsStatus").innerHTML = ""; }
  status($("walletStatus"), why === "forget" ? "good" : "warn", why === "forget" ? "Wallet closed and its address forgotten on this device." : why === "idle" ? `Wallet locked after ${session.IDLE_MINUTES} minutes without use. Load it again to sign.` : "Wallet locked.");
  wRender();
});
// a key unlocked earlier in this tab comes back after a reload
{
  const t = session.unlocked();
  if (t) { try { setWallet(importWallet(t.wif), { quiet: true }); } catch { session.lock(); } }
  // a remembered address but no key in this tab: say so where the wallet is loaded
  else { const r = session.remembered(); if (r) status($("walletStatus"), "warn", `This tab is locked: it remembers your address (${r.address.slice(0, 6)}...${r.address.slice(-4)}) but not your key. The key stays only in the browser tab where you opened it, and locks after ${session.IDLE_MINUTES} minutes without use. Use that tab, or load your key or recovery phrase here once. (For a test, Try a demo payment needs no wallet.)`); }
  wRender();
}

// ---------- Nearby: two phones on the same Wi-Fi or hotspot, linked directly (WebRTC) ----------
// No internet and no server: the connection offer and answer travel as QR codes, and the link
// itself uses only the local network (no STUN or TURN servers are configured, so nothing leaves
// it). Payments sent over it are checked on arrival exactly like scanned ones.
const RTC_TEXT = /^BSVRTC1 ([OA]) ([A-Za-z0-9_-]+)$/;
const b64u = { enc: (u8) => btoa(String.fromCharCode(...u8)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""), dec: (s) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0)) };
async function squeeze(text, way) {
  if (typeof CompressionStream === "undefined") return way === "pack" ? new TextEncoder().encode(text) : new TextDecoder().decode(text);
  const stream = new Blob([way === "pack" ? new TextEncoder().encode(text) : text]).stream().pipeThrough(way === "pack" ? new CompressionStream("deflate-raw") : new DecompressionStream("deflate-raw"));
  const buf = new Uint8Array(await new Response(stream).arrayBuffer());
  return way === "pack" ? buf : new TextDecoder().decode(buf);
}
// Keep the code small and local: UDP candidates on private addresses only (192.168/10/172.16-31,
// IPv6 fc00::/7 and fe80::, or a browser's .local name), and drop lines a data channel does not
// need. Public addresses would reach past the local network, and put them in the QR code.
function trimSdp(sdp) {
  const local = (a) => /\.local$/i.test(a) || /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|127\.)/.test(a) || /^(f[cd][0-9a-f]{2}|fe80):/i.test(a);
  return sdp.split(/\r?\n/).filter((l) => {
    if (/^a=(extmap-allow-mixed|msid-semantic|ice-options)/.test(l)) return false;
    const c = l.match(/^a=candidate:\S+ \d+ (\S+) \d+ (\S+) \d+ typ host/i);
    if (l.startsWith("a=candidate:")) return !!c && c[1].toLowerCase() === "udp" && local(c[2]);
    return true;
  }).join("\r\n");
}
const packSdp = async (kind, sdp) => `BSVRTC1 ${kind} ${typeof CompressionStream === "undefined" ? "R" : "Z"}${b64u.enc(await squeeze(trimSdp(sdp), "pack"))}`;
async function unpackSdp(text) {
  const m = String(text ?? "").trim().match(RTC_TEXT);
  if (!m) return null;
  const raw = m[2], bytes = b64u.dec(raw.slice(1));
  const sdp = raw[0] === "Z" ? await squeeze(bytes, "unpack") : new TextDecoder().decode(bytes);
  return { kind: m[1] === "O" ? "offer" : "answer", sdp };
}
const rtcLink = (t) => `${LINK_BASE}#rtc=${encodeURIComponent(t)}`;
function drawQrOn(canvas, text) {
  const q = qrcode(0, "L"); q.addData(text, "Byte"); q.make();
  const n = q.getModuleCount(), scale = Math.max(4, Math.floor(900 / n)), quiet = 4 * scale, g = canvas.getContext("2d");
  canvas.width = canvas.height = n * scale + 2 * quiet;
  g.fillStyle = "#fff"; g.fillRect(0, 0, canvas.width, canvas.height); g.fillStyle = "#000";
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (q.isDark(r, c)) g.fillRect(quiet + c * scale, quiet + r * scale, scale, scale);
}
function nearbyLog(kind, text) { const li = document.createElement("li"); li.className = `status ${kind}`; li.textContent = `${new Date().toLocaleTimeString()}: ${text}`; $("rtcLog").prepend(li); }

let pc = null, chan = null;
function rtcState(text, kind = "warn") { status($("rtcStatus"), kind, text); }
function wireChannel(ch) {
  chan = ch;
  ch.onopen = () => { releaseCamera(); sendHello(); rtcState("Connected. Payments you send now go straight to the other phone.", "good"); $("rtcSendBox").classList.remove("hidden"); $("rtcQrBox").classList.add("hidden"); stopRtcScan(); };
  ch.onclose = () => { rtcState("Disconnected. Start again to reconnect.", "bad"); $("rtcSendBox").classList.add("hidden"); };
  ch.onmessage = (e) => {
    let m; try { m = JSON.parse(e.data); } catch { return; }
    if (m.t !== "pay" || typeof m.text !== "string") return;
    if (faucetText(m.text)) { nearbyLog("good", "Received a faucet message: see Faucets heard on Get paid."); return; }
    try {
      const { tx, type } = readPayment(m.text);
      received(tx, type, encodePayment(tx, { beef: type === TYPE.PAY_BEEF }).msg);
      nearbyLog("good", `Received payment ${short(tx.id("hex"))}. Checked on Get paid: ${$("getStatus").textContent}`);
      chan.send(JSON.stringify({ t: "ack", txid: tx.id("hex") }));
    } catch (err) { nearbyLog("bad", `Received something that is not a payment: ${err.message}`); }
  };
  ch.addEventListener("message", (e) => { try { const m = JSON.parse(e.data); if (m.t === "hello") gotHello(m.address); if (m.t === "ack") nearbyLog("good", `The other phone received and checked ${short(m.txid)}.`); } catch {} });
}
const RTC_TIPS = "Check that both devices are on the same Wi-Fi (not mobile data), or join one phone's hotspot with the other. Guest Wi-Fi and some routers keep devices apart. Then press Start again on the first device.";
let rtcTimer = null;
async function newPeer() {
  if (pc) try { pc.close(); } catch {}
  clearTimeout(rtcTimer);
  const p = new RTCPeerConnection({ iceServers: [] }); // local network only
  pc = p;
  // each stage in plain words, so a stall shows where it is
  p.oniceconnectionstatechange = () => {
    if (pc !== p) return;
    const st = p.iceConnectionState;
    if (st === "checking") nearbyLog("warn", "Looking for the other device on this network...");
    if (st === "connected" || st === "completed") { clearTimeout(rtcTimer); nearbyLog("good", "Found the other device."); }
    if (st === "failed") { clearTimeout(rtcTimer); releaseCamera(); rtcState(`Could not reach the other device. ${RTC_TIPS}`, "bad"); nearbyLog("bad", "The devices could not reach each other on this network."); }
    if (st === "disconnected") nearbyLog("warn", "Lost the other device. It may come back; if not, press Start again.");
  };
  return p;
}
// if nothing connects within 25 seconds of both codes being in, say what to try
function rtcWatch() {
  clearTimeout(rtcTimer);
  rtcTimer = setTimeout(() => { if (!chan || chan.readyState !== "open") rtcState(`Still not connected. ${RTC_TIPS}`, "bad"); }, 25000);
}
const gathered = (p) => new Promise((r) => { if (p.iceGatheringState === "complete") return r(); p.onicegatheringstatechange = () => { if (p.iceGatheringState === "complete") r(); }; setTimeout(r, 4000); });
async function showRtcQr(kind) {
  const text = await packSdp(kind, pc.localDescription.sdp);
  const cands = trimSdp(pc.localDescription.sdp).split("\n").filter((l) => l.startsWith("a=candidate:"));
  const found = cands.length, hidden = cands.filter((l) => /\.local /i.test(l)).length;
  if (found && hidden === found) nearbyLog("warn", "This device's address is hidden (.local name) in the code. If connecting fails, allow the camera and press Start or Join again.");
  nearbyLog(found ? "good" : "bad", found ? `This device is reachable at ${found} local network address${found > 1 ? "es" : ""}.` : "This device found no local network address. Is it on Wi-Fi or a hotspot, not mobile data?");
  drawQrOn($("rtcQr"), kind === "O" ? rtcLink(text) : text);
  $("rtcQrBox").classList.remove("hidden");
  return text;
}
// Browsers hide a device's local address behind a random ".local" name unless the page is using
// the camera or microphone, and an iPhone and a PC often cannot look up each other's names. So the
// camera is held while connecting (it is needed for the codes anyway): the real local address,
// which only works on this network, then goes in the code. Released once connected.
let camHold = null;
async function holdCamera() {
  if (camHold) return true;
  try { camHold = await navigator.mediaDevices.getUserMedia({ video: true }); return true; }
  catch { nearbyLog("warn", "Camera not allowed, so this device's address stays hidden. Connecting may fail between an iPhone and a PC."); return false; }
}
function releaseCamera() { camHold?.getTracks().forEach((t) => t.stop()); camHold = null; }

async function rtcStart() {
  await holdCamera();
  const p = await newPeer();
  wireChannel(p.createDataChannel("bsvkey-pay", { ordered: true }));
  await p.setLocalDescription(await p.createOffer());
  await gathered(p);
  const text = await showRtcQr("O");
  $("rtcQrNote").textContent = "1. Let the other phone scan this (its camera app works too). 2. Then press Scan their answer.";
  $("rtcScanAnswer").classList.remove("hidden");
  rtcState("Waiting for the other phone to scan this code.");
  return text;
}
async function rtcJoin(offerText) {
  const o = await unpackSdp(offerText);
  if (!o || o.kind !== "offer") throw new Error("that is not a Nearby connection code");
  await holdCamera();
  const p = await newPeer();
  p.ondatachannel = (e) => wireChannel(e.channel);
  await p.setRemoteDescription({ type: "offer", sdp: o.sdp });
  await p.setLocalDescription(await p.createAnswer());
  await gathered(p);
  const text = await showRtcQr("A");
  $("rtcQrNote").textContent = "Now let the first phone scan this answer, from its Nearby tab (Scan their answer).";
  rtcState("Waiting for the first phone to scan this answer.");
  setTimeout(rtcWatch, 20000); // allow time for the scan, then the usual wait
  return text;
}
async function rtcFinish(answerText) {
  const a = await unpackSdp(answerText);
  if (!a || a.kind !== "answer") throw new Error("that is not a Nearby answer code");
  if (!pc) throw new Error("press Start first");
  if (pc.signalingState !== "have-local-offer") {
    // the answer was already taken (scanned twice): nothing to do but wait, or start over
    if (chan?.readyState === "open") return rtcState("Already connected.", "good");
    if (pc.remoteDescription) return rtcState("That answer is already in. Still connecting: give it a few seconds. If nothing happens, press Start again.");
    throw new Error("press Start again: this connection code is no longer active");
  }
  await pc.setRemoteDescription({ type: "answer", sdp: a.sdp });
  rtcState("Both codes are in. Connecting...");
  rtcWatch();
}

// a small camera reader for the Nearby codes
let rtcStop = null;
function stopRtcScan() { rtcStop?.(); rtcStop = null; $("rtcVideo").classList.add("hidden"); }
async function rtcScan(onText) {
  stopRtcScan();
  const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" } });
  const video = $("rtcVideo"); video.srcObject = stream; video.classList.remove("hidden"); await video.play();
  const detector = "BarcodeDetector" in window ? new window.BarcodeDetector({ formats: ["qr_code"] }) : null;
  const canvas = document.createElement("canvas"), g = canvas.getContext("2d", { willReadFrequently: true });
  let live = true;
  rtcStop = () => { live = false; stream.getTracks().forEach((t) => t.stop()); };
  const tick = async () => {
    if (!live) return;
    let text = null;
    if (video.videoWidth) {
      if (detector) text = (await detector.detect(video).catch(() => []))[0]?.rawValue ?? null;
      else { canvas.width = video.videoWidth; canvas.height = video.videoHeight; g.drawImage(video, 0, 0); const img = g.getImageData(0, 0, canvas.width, canvas.height); text = jsQR(img.data, img.width, img.height)?.data ?? null; }
    }
    if (text) { const m = String(text).match(/#rtc=([^#]+)$/); if (m) text = decodeURIComponent(m[1]); }
    if (text && RTC_TEXT.test(text.trim())) { stopRtcScan(); try { await onText(text.trim()); } catch (e) { rtcState(e.message, "bad"); } return; }
    requestAnimationFrame(tick);
  };
  tick();
}
$("rtcStart").onclick = async () => { try { await rtcStart(); } catch (e) { rtcState(`Could not start: ${e.message}`, "bad"); } };
$("rtcJoin").onclick = async () => { try { rtcState("Point the camera at the first phone's code."); await rtcScan(rtcJoin); } catch (e) { rtcState(mediaError("camera", e), "bad"); } };
$("rtcScanAnswer").onclick = async () => { try { rtcState("Point the camera at the other phone's answer."); await rtcScan(rtcFinish); } catch (e) { rtcState(mediaError("camera", e), "bad"); } };
// ---- the two devices tell each other where to be paid ----
let peerAddr = null;
const myPayAddr = () => wallet?.address || $("myAddr").value.trim() || null;
function sendHello() { if (chan?.readyState === "open") chan.send(JSON.stringify({ t: "hello", address: myPayAddr() })); }
function gotHello(address) {
  let ok = false;
  try { if (typeof address === "string") { new P2PKH().lock(address); ok = true; } } catch {}
  peerAddr = ok ? address : null;
  $("rtcPayBox").classList.toggle("hidden", !peerAddr);
  $("rtcNoPeerAddr").classList.toggle("hidden", !!peerAddr);
  if (!peerAddr) return;
  $("rtcPeerAddr").textContent = peerAddr;
  if (!$("to").value.trim() || $("to").dataset.fromPeer === "1") { $("to").value = peerAddr; $("to").dataset.fromPeer = "1"; }
  nearbyLog("good", `The other device will be paid at ${short(peerAddr)}.`);
}
$("myAddr").addEventListener("change", sendHello);
$("rtcPay").onclick = async () => {
  if (!chan || chan.readyState !== "open") return rtcState("Not connected.", "bad");
  if (!peerAddr) return nearbyLog("warn", "The other device has not shared an address yet.");
  if (!wallet) return nearbyLog("warn", "Open your wallet first: Pay tab, Send real BSV (or the Open wallet button at the top).");
  if (!coins.length) {
    // online? fetch them now; offline, the person has to load a funding transaction
    nearbyLog("warn", "Getting your coins from WhatsOnChain...");
    try { coins = await fetchCoins(wallet.address); showCoins(); }
    catch (e) { return nearbyLog("bad", `Could not get your coins (${e.message}). With no internet, paste a funding transaction under Send real BSV on the Pay tab.`); }
    if (!coins.length) return nearbyLog("bad", `Your wallet ${short(wallet.address)} has no coins to spend.`);
  }
  try {
    $("to").value = peerAddr; $("sats").value = $("rtcSats").value;
    await $("sign").onclick();
    if (!current?.check?.ok || !current.tx.outputs.some((o) => o.lockingScript.toHex() === new P2PKH().lock(peerAddr).toHex())) return nearbyLog("bad", $("payStatus").textContent);
    $("rtcSend").click();
  } catch (e) { nearbyLog("bad", e.message); }
};

$("rtcDemo").onclick = async () => {
  if (!chan || chan.readyState !== "open") return rtcState("Not connected.", "bad");
  const to = $("myAddr").value.trim() || PrivateKey.fromRandom().toAddress();
  const { tx } = await demoPayment({ to, sats: 1000 });
  setPayment(tx, TYPE.PAY_EF);
  status($("payStatus"), "warn", "Demo payment: signed correctly, but its funding is made up, so a gateway can check it and the network would refuse it.");
  $("broadcastPay").disabled = true;
  $("rtcSend").click();
};
$("rtcSend").onclick = () => {
  if (!chan || chan.readyState !== "open") return rtcState("Not connected.", "bad");
  if (!current?.check?.ok) return nearbyLog("warn", "Load or sign a payment on the Pay tab first.");
  chan.send(JSON.stringify({ t: "pay", text: current.text }));
  nearbyLog("good", `Sent payment ${short(current.tx.id("hex"))} to the other phone.`);
};

// ---------- opened from a QR code link (#pay=... or #rtc=...) ----------
{
  if (location.hash.startsWith("#rtc=")) {
    let code = ""; try { code = decodeURIComponent(location.hash.slice(5)); } catch {}
    history.replaceState(null, "", location.pathname + location.search);
    document.querySelector('[data-tab="nearby"]').click();
    $("guide").open = false;
    rtcJoin(code).catch((e) => rtcState(e.message, "bad"));
  }
  const raw = location.hash.startsWith("#pay=") ? fromLink(location.hash) : null;
  if (raw) {
    history.replaceState(null, "", location.pathname + location.search); // keep it out of the address bar and history
    document.querySelector('[data-tab="get"]').click();
    $("guide").open = false;
    const part = parseText(raw);
    if (faucetText(raw)) status($("getStatus"), "good", "Opened from a QR code: the faucet message is under Faucets heard.");
    else if (part && part.of) status($("getStatus"), "warn", `This QR code is part ${part.part} of ${part.of} of a longer payment. Press Scan QR code here to read all the parts.`);
    else {
      $("getPaste").value = raw;
      $("getLoad").click();
      if (!$("myAddr").value.trim()) status($("getStatus"), "warn", "Opened from a QR code and checked: it is under Waiting to be sent below. Press Broadcast now there to send it to the network. To see what it pays you, add your address above and press Check it.");
    }
    setTimeout(() => $("getStatus").scrollIntoView({ behavior: "smooth", block: "center" }), 300);
  }
}

// for checks from the browser console (and the built-in browser test)
window.handoff = { nearby: { trimSdp, rtcStart, rtcJoin, rtcFinish, state: () => ({ pc: pc?.connectionState, chan: chan?.readyState }) }, asLink, fromLink, listenStats, faucetText, readPayment, setPayment, received, current: () => current, jsQR, codec, soundChunks, parseChunk, soundAssembler, parseText };
