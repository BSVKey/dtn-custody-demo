// Payments as sound (radio/lib/sound.mjs), offline: a payment is cut into ggwave chunks, played
// into a simulated room (quieter, with noise and silence, captured in odd block sizes like a
// microphone delivers), and rebuilt byte for byte. Synthetic funding; nothing is broadcast.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { encodePayment, demoPayment } from "../radio/lib/payment.mjs";
import { soundChunks, parseChunk, soundAssembler, ggwaveCodec } from "../radio/lib/sound.mjs";

const codec = ggwaveCodec(await createRequire(import.meta.url)("ggwave")()); // one per process: each holds WebAssembly memory

function room(samples, { gain = 0.3, noise = 0.05, lead = 12000 } = {}) {
  const out = new Float32Array(samples.length + 2 * lead);
  for (let i = 0; i < out.length; i++) out[i] = (i >= lead && i - lead < samples.length ? samples[i - lead] * gain : 0) + (Math.random() - 0.5) * noise;
  return out;
}

function hear(chunks, speed, block = 777, order = chunks) {
  const asm = soundAssembler();
  let result = null, seconds = 0;
  for (const text of order) {
    const s = codec.encode(text, speed); seconds += s.length / codec.sampleRate;
    const sig = room(s);
    for (let o = 0; o < sig.length; o += block) for (const t of codec.decode(sig.subarray(o, o + block))) { const p = parseChunk(t); if (p) result = asm.add(p); }
  }
  return { result, seconds };
}

test("chunks: fit ggwave's 140-character limit and rebuild in any order", async () => {
  const { tx } = await demoPayment();
  const { type, msg } = encodePayment(tx);
  const chunks = soundChunks(type, msg);
  assert.equal(chunks.length, 3);
  assert.ok(chunks.every((c) => c.length <= 140 && /^[\x20-\x7e]+$/.test(c)));
  const asm = soundAssembler();
  let r;
  for (const c of [chunks[2], chunks[0], chunks[0], chunks[1]]) r = asm.add(parseChunk(c));
  assert.deepEqual(r.msg, msg);
  const bad = soundAssembler();
  bad.add(parseChunk(chunks[0])); bad.add(parseChunk(chunks[1]));
  assert.equal(bad.add(parseChunk(chunks[2].slice(0, -4) + "AAAA")).corrupt, true);
  assert.equal(parseChunk("hello"), null);
});

test("sound: a payment played into a noisy room is rebuilt exactly (Fastest and Fast)", async () => {
  const { tx } = await demoPayment();
  const { type, msg } = encodePayment(tx);
  const chunks = soundChunks(type, msg);
  const fastest = hear(chunks, "fastest");
  assert.deepEqual(fastest.result?.msg, msg);
  assert.ok(fastest.seconds > 10 && fastest.seconds < 18, `fastest took ${fastest.seconds} s`);
  const fast = hear(chunks, "fast", 4096, [chunks[1], chunks[0], chunks[2]]);
  assert.deepEqual(fast.result?.msg, msg);
  assert.ok(fast.seconds > 20 && fast.seconds < 32, `fast took ${fast.seconds} s`);
});
