#!/usr/bin/env node
// Decode a recording: whatever came out of a walkie-talkie, a radio or a phone call, saved as WAV.
// Payments are rebuilt and checked offline; plain-text messages (beacons, station IDs) are shown.
//
//   node radio/audio/decode-wav.mjs recording.wav [--address <yours> --sats <expected>]
//   node radio/audio/decode-wav.mjs pay.wav --simulate walkie     run it through a simulated channel first
//
// Prints the payment as a BSV1 text, ready to text to an SMS gateway or paste into the phone page.
import { readFileSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { ggwaveCodec, parseChunk, soundAssembler, QUIET } from "../lib/sound.mjs";
import { simulateChannel } from "../lib/channels.mjs";
import { decodePayment, checkOffline, paysAddress } from "../lib/payment.mjs";
import { paymentTexts } from "../sms/text.mjs";
import { readWav } from "./wav.mjs";

// samples -> { payments: [{ type, msg }], messages: [text], corrupt }
export function decodeSamples(codec, samples, block = 4096) {
  const asm = soundAssembler(), payments = [], messages = [];
  let corrupt = 0;
  for (let o = 0; o < samples.length; o += block) for (const t of codec.decode(samples.subarray(o, o + block))) {
    const c = parseChunk(t);
    if (!c) { if (!messages.includes(t)) messages.push(t); continue; }
    const r = asm.add(c);
    if (r.corrupt) corrupt++;
    else if (r.msg && !payments.some((p) => Buffer.compare(p.msg, r.msg) === 0)) payments.push(r);
  }
  return { payments, messages, corrupt };
}

async function main() {
  const file = process.argv[2];
  const arg = (k) => { const a = process.argv.find((x) => x.startsWith(`--${k}=`)); if (a) return a.slice(k.length + 3); const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : undefined; };
  if (!file || file.startsWith("--")) { console.error("usage: node radio/audio/decode-wav.mjs <recording.wav> [--address <yours> --sats <n>] [--simulate speaker|fm|am|walkie|phone]"); process.exit(2); }
  let { samples, sampleRate } = readWav(readFileSync(file));
  if (arg("simulate")) samples = simulateChannel(samples, arg("simulate"), { sampleRate });
  const codec = ggwaveCodec(await createRequire(import.meta.url)("ggwave")(QUIET), { sampleRate });
  const { payments, messages, corrupt } = decodeSamples(codec, samples);
  console.log(`${file}: ${(samples.length / sampleRate).toFixed(1)} s at ${sampleRate} Hz${arg("simulate") ? `, through a simulated ${arg("simulate")} channel` : ""}`);
  for (const m of messages) console.log(`message: ${m}`);
  if (corrupt) console.log(`${corrupt} payment(s) heard with parts that did not fit together`);
  if (!payments.length) { console.log("no complete payment heard"); process.exit(messages.length ? 0 : 1); }
  for (const { type, msg } of payments) {
    const tx = decodePayment(type, msg), c = checkOffline(tx);
    console.log(`payment ${tx.id("hex")}: ${c.ok ? `signatures valid, fee ${c.fee} sat` : `INVALID: ${c.reason}`}`);
    if (arg("address")) { const p = paysAddress(tx, arg("address"), Number(arg("sats") ?? 0)); console.log(`  pays ${arg("address")}: ${p.got} sat${p.ok ? "" : " (less than expected)"}`); }
    console.log(`  forward as text: ${paymentTexts(type, msg)[0]}`);
  }
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) await main();
