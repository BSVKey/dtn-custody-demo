#!/usr/bin/env node
// Pay over radio, end to end, on a simulated LoRa link (no hardware, no internet, no real BSV).
//
//   node radio/run-demo.mjs                      LongFast, 25% packet loss, EF payment
//   node radio/run-demo.mjs --loss=0.4 --beef    heavier loss, BEEF payment
//   node radio/run-demo.mjs --preset=ShortFast --realtime
//
// A payer signs a payment with no network, the payee checks it offline, the payment crosses
// the lossy radio link in frames, the gateway rebuilds it, checks it and (in this demo) does not
// broadcast, and a receipt signed by the gateway comes back over the same link. The funding
// transaction is synthetic, so nothing here is spendable or sent anywhere.
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { PrivateKey } from "@bsv/sdk";
import { loraLink } from "./lib/link.mjs";
import { startGateway } from "./lib/gateway.mjs";
import { sendPayment } from "./lib/sender.mjs";
import { checkOffline, paysAddress, demoPayment } from "./lib/payment.mjs";
import { DEFAULT_MTU } from "./lib/frame.mjs";

export { demoPayment } from "./lib/payment.mjs";

const STATUS_TEXT = { 1: "accepted by broadcaster", 2: "valid, not broadcast", 3: "rejected", 4: "broadcast failed" };

async function main() {
  const arg = (k, d) => { const a = process.argv.find((x) => x.startsWith(`--${k}=`)); return a ? a.slice(k.length + 3) : d; };
  const has = (k) => process.argv.includes(`--${k}`);
  const loss = Number(arg("loss", "0.25")), preset = arg("preset", "LongFast"), seed = Number(arg("seed", "7"));
  const realtime = has("realtime"), beef = has("beef");
  const t0 = Date.now(), at = () => `${String(Date.now() - t0).padStart(6)} ms`;

  const link = loraLink({ loss, preset, seed, timeScale: realtime ? 1 : 0 });
  const gatewayKey = PrivateKey.fromRandom();
  const gwPub = gatewayKey.toPublicKey().toString();
  console.log(`radio link: Meshtastic ${preset} (SF${link.radio.sf}, ${link.radio.bwHz / 1000} kHz, CR 4/${link.radio.cr + 4}), ${Math.round(loss * 100)}% packet loss, MTU ${DEFAULT_MTU} B${realtime ? ", real time on air" : ""}`);
  console.log(`gateway key (pinned by the sender): ${gwPub}\n`);

  const { tx, to, sats } = await demoPayment();
  const off = checkOffline(tx), pays = paysAddress(tx, to, sats);
  console.log(`payer signed ${tx.id("hex")} offline: ${sats} sat to ${to}`);
  console.log(`payee check with no internet: signatures ${off.ok ? "valid" : "INVALID"}, pays ${pays.got} sat ${pays.ok ? ">=" : "<"} ${sats}, fee ${off.fee} sat`);
  console.log(`  (an offline check cannot rule out a double spend; the gateway's receipt settles that)\n`);

  const gw = startGateway({ radio: link.b, key: gatewayKey, nackAfterMs: realtime ? 6000 : 60, log: (e) => {
    if (e.ev === "nack") console.log(`${at()}  gateway  NACK: missing frames ${e.missing.join(", ")}`);
    if (e.ev === "payment") console.log(`${at()}  gateway  rebuilt ${e.bytes} B, ${e.ok ? "checked offline OK" : `REJECTED: ${e.detail}`}; ${STATUS_TEXT[e.status]}; receipt sent`);
  } });
  const res = await sendPayment({ radio: link.a, tx, gatewayPub: gwPub, beef, waitMs: realtime ? 20_000 : 200, tries: 6, log: (e) => {
    if (e.ev === "send") console.log(`${at()}  payer    ${e.format} payment ${e.bytes} B in ${e.frames} frames`);
    if (e.ev === "resend") console.log(`${at()}  payer    resending frames ${e.frames.join(", ")}`);
    if (e.ev === "timeout") console.log(`${at()}  payer    no answer, sending the whole payment again`);
  } });
  gw.stop();

  const s = link.stats;
  console.log(`\nlink: ${s.sent} frames (${s.bytes} B), ${s.lost} lost, ${(s.airtimeMs / 1000).toFixed(1)} s total time on air`);
  if (!res.receipt) { console.log("NO RECEIPT: payment not confirmed by the gateway"); process.exit(1); }
  const r = res.receipt;
  console.log(`receipt: signed by the pinned gateway, txid ${r.txid === res.txid ? "matches" : "DOES NOT MATCH"}, status ${r.status}, at ${new Date(r.time * 1000).toISOString()}`);
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) await main();
