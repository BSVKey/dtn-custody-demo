#!/usr/bin/env node
// Pay over real Meshtastic radios. Two machines (or one with two radios), each with a radio on USB.
//
// Gateway (has internet):
//   node radio/cli.mjs gateway --port COM4 --key-file gateway.wif
//       checks payments and radios back signed receipts; broadcasts NOTHING
//   ... --spend-real-bsv [--arc https://arc.gorillapool.io]
//       also broadcasts valid payments on BSV mainnet
//
// Payer, while still online (once): save the funding transaction for offline use
//   node radio/cli.mjs fetch-fund <txid> > fund.hex
//
// Payer (no internet needed):
//   node radio/cli.mjs send --port COM5 --wif-file payer.wif --fund-file fund.hex \
//       --to <address> --sats 1000 --gateway-pub <hex from the gateway's start line>
//
// Any --port <serial> can be --host <ip[:port]> instead: a Meshtastic node on the network
// (meshtasticd, or a radio on Wi-Fi).
//
// Key files are yours: read, never written or printed. Not yet run against real hardware.
import { readFileSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { PrivateKey, Transaction, P2PKH, SatoshisPerKilobyte } from "@bsv/sdk";
import { meshtasticRadio } from "./meshtastic.mjs";
import { startGateway, arcBroadcaster, dryRun } from "./lib/gateway.mjs";
import { sendPayment } from "./lib/sender.mjs";
import { checkOffline } from "./lib/payment.mjs";

const WOC = "https://api.whatsonchain.com/v1/bsv/main";
const STATUS_TEXT = { 1: "accepted by broadcaster", 2: "valid, not broadcast", 3: "rejected", 4: "broadcast failed" };

// Build and sign offline: spend the output of fundTx that pays the payer key.
export async function buildRadioPayment({ payer, fundTx, to, sats, feeRate = 100 }) {
  const ours = new P2PKH().lock(payer.toAddress()).toHex();
  const vout = fundTx.outputs.findIndex((o) => o.lockingScript.toHex() === ours);
  if (vout < 0) throw new Error(`funding transaction does not pay ${payer.toAddress()}`);
  if (fundTx.outputs[vout].satoshis < sats) throw new Error(`funding output has ${fundTx.outputs[vout].satoshis} sat; payment is ${sats} plus fee`);
  const tx = new Transaction();
  tx.addInput({ sourceTransaction: fundTx, sourceOutputIndex: vout, unlockingScriptTemplate: new P2PKH().unlock(payer) });
  tx.addOutput({ lockingScript: new P2PKH().lock(to), satoshis: sats });
  tx.addOutput({ lockingScript: new P2PKH().lock(payer.toAddress()), change: true });
  await tx.fee(new SatoshisPerKilobyte(feeRate));
  await tx.sign();
  return tx;
}

async function main() {
  const [mode, pos] = process.argv.slice(2);
  const arg = (k) => { const a = process.argv.find((x) => x.startsWith(`--${k}=`)); if (a) return a.slice(k.length + 3); const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : undefined; };
  const has = (k) => process.argv.includes(`--${k}`);
  const ts = () => new Date().toISOString().slice(11, 19);

  if (mode === "fetch-fund") {
    const hex = await fetch(`${WOC}/tx/${pos}/hex`).then((r) => (r.ok ? r.text() : null));
    if (!hex) { console.error(`transaction ${pos} not found on mainnet`); process.exit(2); }
    process.stdout.write(hex.trim() + "\n");
    return;
  }

  if (mode === "gateway") {
    const keyFile = arg("key-file");
    if (!keyFile) { console.error("usage: node radio/cli.mjs gateway --port <serial> --key-file <gateway.wif> [--spend-real-bsv] [--arc <url>]"); process.exit(2); }
    const key = PrivateKey.fromWif(readFileSync(keyFile, "utf8").trim());
    const radio = meshtasticRadio({ port: arg("port"), host: arg("host"), gapMs: Number(arg("gap-ms") ?? 3000) });
    const node = await radio.ready;
    const real = has("spend-real-bsv");
    console.log(`${ts()} gateway up on radio ${node}; receipt key ${key.toPublicKey().toString()}`);
    console.log(`${ts()} ${real ? `BROADCASTING valid payments on BSV MAINNET via ${arg("arc") ?? "https://arc.gorillapool.io"}` : "dry run: payments are checked, never broadcast (add --spend-real-bsv to send)"}`);
    startGateway({ radio, key, broadcast: real ? arcBroadcaster(arg("arc")) : dryRun, nackAfterMs: Number(arg("nack-ms") ?? 20000), log: (e) => {
      if (e.ev === "nack") console.log(`${ts()} NACK ${e.id}: missing frames ${e.missing.join(", ")}`);
      if (e.ev === "payment") console.log(`${ts()} payment ${e.txid}: ${STATUS_TEXT[e.status]}${e.detail ? ` (${e.detail})` : ""}`);
      if (e.ev === "corrupt" || e.ev === "gave-up") console.log(`${ts()} ${e.ev} ${e.id}`);
    } });
    return;
  }

  if (mode === "send") {
    const need = ["wif-file", "fund-file", "to", "sats", "gateway-pub"].filter((k) => !arg(k));
    if (need.length) { console.error(`missing --${need.join(", --")}\nusage: node radio/cli.mjs send --port <serial> --wif-file <payer.wif> --fund-file <fund.hex> --to <address> --sats <n> --gateway-pub <hex> [--beef] [--fee-rate <sat/kB>]`); process.exit(2); }
    const payer = PrivateKey.fromWif(readFileSync(arg("wif-file"), "utf8").trim());
    const fundTx = Transaction.fromHex(readFileSync(arg("fund-file"), "utf8").trim());
    const tx = await buildRadioPayment({ payer, fundTx, to: arg("to"), sats: Number(arg("sats")), feeRate: Number(arg("fee-rate") ?? 100) });
    const c = checkOffline(tx);
    console.log(`${ts()} signed ${tx.id("hex")} offline: ${arg("sats")} sat to ${arg("to")}, fee ${c.fee} sat`);
    const radio = meshtasticRadio({ port: arg("port"), host: arg("host"), gapMs: Number(arg("gap-ms") ?? 3000) });
    await radio.ready;
    const res = await sendPayment({ radio, tx, gatewayPub: arg("gateway-pub"), beef: has("beef"), waitMs: Number(arg("wait-ms") ?? 60000), tries: 5, log: (e) => {
      if (e.ev === "send") console.log(`${ts()} sending ${e.format} payment, ${e.bytes} B in ${e.frames} frames`);
      if (e.ev === "resend") console.log(`${ts()} gateway asked again for frames ${e.frames.join(", ")}`);
      if (e.ev === "timeout") console.log(`${ts()} no answer, sending again (try ${e.attempt + 1})`);
    } });
    radio.close();
    if (!res.receipt) { console.log(`${ts()} no receipt. The payment may or may not have reached the gateway; check ${tx.id("hex")} later before paying again.`); process.exit(1); }
    console.log(`${ts()} receipt from the gateway: ${res.receipt.status} for ${res.receipt.txid}`);
    return;
  }

  console.error("usage: node radio/cli.mjs gateway|send|fetch-fund ...  (see the top of radio/cli.mjs)");
  process.exit(2);
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) await main();
