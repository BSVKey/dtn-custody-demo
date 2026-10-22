// Sound over radio and phone audio (radio/lib/channels.mjs, radio/audio/, radio/lib/ham.mjs),
// in simulation only: each channel profile's tones carry a payment through that channel's band
// limits and noise; the audible tones do not survive a walkie-talkie (why the dual-tone profile
// exists); WAV files round-trip; the amateur profile refuses payment traffic and identifies.
// Synthetic funding; nothing is broadcast or transmitted.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { encodePayment, demoPayment } from "../radio/lib/payment.mjs";
import { soundChunks, ggwaveCodec, QUIET } from "../radio/lib/sound.mjs";
import { CHANNELS, simulateChannel } from "../radio/lib/channels.mjs";
import { hamPlan, hamRefusal } from "../radio/lib/ham.mjs";
import { paymentTexts } from "../radio/sms/text.mjs";
import { render } from "../radio/audio/make-wav.mjs";
import { decodeSamples } from "../radio/audio/decode-wav.mjs";
import { writeWav, readWav } from "../radio/audio/wav.mjs";

const codec = ggwaveCodec(await createRequire(import.meta.url)("ggwave")(QUIET));
const { tx } = await demoPayment();
const { type, msg } = encodePayment(tx);
const chunks = soundChunks(type, msg);

for (const [name, ch] of Object.entries(CHANNELS)) {
  // Played twice, as the phone page and make-wav do. Played once, 250 random payments lost 14 on
  // the phone speaker and 1 on FM (none twice), which made this test fail now and then.
  test(`channel ${name}: ${ch.speed} tones carry a payment through a simulated ${ch.label}`, () => {
    const audio = simulateChannel(render(codec, chunks, { speed: ch.speed, leadInS: ch.leadInS, repeat: 2 }), name, { seed: 7 });
    const { payments } = decodeSamples(codec, audio);
    assert.equal(payments.length, 1);
    assert.deepEqual(payments[0].msg, msg);
  });
}

test("walkie-talkie: the audible tones are lost, so the profile uses dual tone (about 40 s a payment)", () => {
  const audible = decodeSamples(codec, simulateChannel(render(codec, chunks, { speed: "fastest", repeat: 1 }), "walkie"));
  assert.equal(audible.payments.length, 0);
  const s = render(codec, chunks, { speed: "dt-fastest", leadInS: 0, gapS: 0, repeat: 1 }).length / codec.sampleRate;
  assert.ok(s > 35 && s < 45, `dt-fastest took ${s} s`);
});

test("wav: written and read back sample for sample (16-bit)", () => {
  const audio = render(codec, chunks.slice(0, 1), { speed: "fastest", repeat: 1 });
  const back = readWav(writeWav(audio, 48000));
  assert.equal(back.sampleRate, 48000);
  assert.equal(back.samples.length, audio.length);
  let worst = 0;
  for (let i = 0; i < audio.length; i++) worst = Math.max(worst, Math.abs(back.samples[i] - audio[i]));
  assert.ok(worst < 1 / 16000);
  assert.throws(() => readWav(Buffer.from("not a wav file at all")));
});

test("ham: payments, receipts and opaque data are refused; plain text gets station ID first, in time, and last", () => {
  for (const t of [...chunks, paymentTexts(type, msg)[0], "BSV RECEIPT ACCEPTED abc", "F12" + "a".repeat(30), "Zm9vYmFyYmF6cXV4cXV1eHF1dXg=", "ab".repeat(20)]) assert.ok(hamRefusal(t), `not refused: ${t.slice(0, 20)}`);
  assert.equal(hamRefusal("test beacon, please report signal"), null);
  assert.throws(() => hamPlan(["hello"], { callsign: "not a call", durationS: () => 1 }), /callsign/);
  assert.throws(() => hamPlan([chunks[0]], { callsign: "N0CALL", durationS: () => 1 }), /refused/);
  const plan = hamPlan(Array(20).fill("test beacon"), { callsign: "n0call", durationS: (t) => (t.startsWith("DE") ? 5 : 60) });
  assert.equal(plan[0], "DE N0CALL");
  assert.equal(plan.at(-1), "DE N0CALL");
  let since = 0;
  for (const t of plan) { since = t.startsWith("DE") ? 5 : since + 60; assert.ok(since <= 9.5 * 60); }
});

test("faucet over a walkie-talkie: the announcement and bearer coin lines come through intact", async () => {
  const { PrivateKey } = await import("@bsv/sdk");
  const { buildFanout, parseAnnouncement, parseCoinLine } = await import("../radio/faucet/faucet.mjs");
  const { announceLines } = await import("../radio/faucet/cli.mjs");
  const master = PrivateKey.fromRandom();
  const { tx: fundTx } = await demoPayment({ to: master.toAddress(), sats: 5000, fund: 9000 });
  const b = await buildFanout({ master, fundTx, coinSats: 500, count: 2, mode: "bearer" });
  const lines = announceLines({ config: { id: b.id, funding: b.funding, mode: "bearer", coinSats: 500, count: 2, fanoutTxid: b.tx.id("hex") }, master });
  const ch = CHANNELS.walkie;
  // Played twice, as the faucet does: played once, about 1 run in 150 lost a whole line. A line
  // lost in the first pass arrives in the second, so compare without order.
  const { messages } = decodeSamples(codec, simulateChannel(render(codec, lines, { speed: ch.speed, leadInS: ch.leadInS, repeat: 2 }), "walkie", { seed: 3 }));
  assert.deepEqual([...messages].sort(), [...lines].sort());
  assert.ok(parseAnnouncement(messages.find((m) => m.startsWith("BSVF1 "))));
  assert.deepEqual(messages.map(parseCoinLine).filter(Boolean).map((c) => c.i).sort(), [0, 1]);
});
