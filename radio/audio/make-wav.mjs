#!/usr/bin/env node
// Make a WAV file to play into a transmitter, a station's audio feed, or a phone call.
//
//   node radio/audio/make-wav.mjs --channel walkie --demo --out pay.wav
//   node radio/audio/make-wav.mjs --channel fm --payment payment.txt --out pay.wav
//       payment.txt: EF or BEEF hex, or a BSV1 text, as the phone page or radio/cli.mjs makes
//   node radio/audio/make-wav.mjs --channel am --text "test, test" --out beacon.wav
//   node radio/audio/make-wav.mjs --ham <CALLSIGN> --channel walkie --text "test beacon" --out ham.wav
//       amateur bands: plain text only, with station ID; payments are always refused
//
// Channels: speaker, fm, am, walkie, phone (radio/lib/channels.mjs). Each picks the tones that
// survive it and a lead-in of silence for push-to-talk or a station's switching. --repeat plays
// the whole thing again (default 2), --speed overrides the tones.
//
// Simulated only: not yet played over a real walkie-talkie, AM or FM transmitter.
import { readFileSync, writeFileSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { ggwaveCodec, soundChunks, QUIET } from "../lib/sound.mjs";
import { CHANNELS } from "../lib/channels.mjs";
import { hamPlan, hamRefusal } from "../lib/ham.mjs";
import { encodePayment, decodePayment, demoPayment } from "../lib/payment.mjs";
import { parseText } from "../sms/text.mjs";
import { TYPE } from "../lib/frame.mjs";
import { writeWav } from "./wav.mjs";

export function readPaymentText(s) {
  const t = parseText(s);
  if (t?.msg) return { type: t.type, msg: t.msg };
  const bytes = Buffer.from(s.replace(/\s+/g, ""), "hex");
  for (const type of [TYPE.PAY_EF, TYPE.PAY_BEEF]) { try { decodePayment(type, bytes); return { type, msg: bytes }; } catch {} }
  throw new Error("not a payment: give EF or BEEF hex, or a BSV1 text");
}

// texts -> one Float32Array: lead-in, each message with a gap, the whole sequence `repeat` times
export function render(codec, texts, { speed, leadInS = 1, gapS = 0.6, repeat = 2 }) {
  const sr = codec.sampleRate, parts = [new Float32Array(Math.round(leadInS * sr))];
  for (let r = 0; r < repeat; r++) for (const t of texts) { parts.push(codec.encode(t, speed)); parts.push(new Float32Array(Math.round(gapS * sr))); }
  const out = new Float32Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

async function main() {
  const arg = (k) => { const a = process.argv.find((x) => x.startsWith(`--${k}=`)); if (a) return a.slice(k.length + 3); const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : undefined; };
  const has = (k) => process.argv.includes(`--${k}`);
  const name = arg("channel") ?? "speaker", ch = CHANNELS[name], out = arg("out");
  if (!ch || !out) { console.error(`usage: node radio/audio/make-wav.mjs --channel ${Object.keys(CHANNELS).join("|")} (--demo | --payment <file> | --text "<message>") --out <file.wav> [--ham <CALLSIGN>] [--repeat 2] [--speed <tones>]`); process.exit(2); }
  const speed = arg("speed") ?? ch.speed, repeat = Number(arg("repeat") ?? 2), ham = arg("ham");
  const codec = ggwaveCodec(await createRequire(import.meta.url)("ggwave")(QUIET));
  let texts, what;
  if (arg("text") != null) { texts = [arg("text")]; what = "text message"; }
  else if (has("demo") || arg("payment")) {
    if (ham) { console.error(`refused: ${hamRefusal("BSV1 E")}`); process.exit(2); }
    const { type, msg } = has("demo") ? encodePayment((await demoPayment()).tx) : readPaymentText(readFileSync(arg("payment"), "utf8"));
    texts = soundChunks(type, msg); what = `${has("demo") ? "demo " : ""}payment, ${msg.length} bytes in ${texts.length} chunks`;
  } else { console.error("give --demo, --payment <file> or --text"); process.exit(2); }
  if (ham) {
    try { texts = hamPlan(texts, { callsign: ham, durationS: (t) => codec.encode(t, speed).length / codec.sampleRate }); }
    catch (e) { console.error(e.message); process.exit(2); }
    what += `, with station ID ${ham.toUpperCase()}`;
  }
  const samples = render(codec, texts, { speed, leadInS: ch.leadInS, repeat });
  writeFileSync(out, writeWav(samples, codec.sampleRate));
  console.log(`${out}: ${what}; ${ch.label}, ${speed} tones, played ${repeat}x; ${(samples.length / codec.sampleRate).toFixed(1)} s at ${codec.sampleRate} Hz`);
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) await main();
