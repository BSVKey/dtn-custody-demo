// A payment as sound, phone to phone, with ggwave (data over sound: FSK with Reed-Solomon error
// correction, MIT). One ggwave message holds at most 140 characters and ggwave mangles bytes
// above 127, so the payment goes as base64 text in chunks:
//
//   S <part 1-9a-z> <count> <first 8 hex of the message id> <up to 128 base64 characters>
//
// A 266-byte EF payment is 3 chunks: about 26 s of sound on the Fast setting, 14 s on Fastest,
// and about 40 s on dual-tone Fastest for narrow channels (measured from the generated audio at
// 48 kHz). The 8-byte message id is checked on the
// rebuilt payment, so a chunk from another payment cannot slip in unnoticed.
import { messageId, TYPE } from "./frame.mjs";

const DIGITS = "123456789abcdefghijklmnopqrstuvwxyz"; // part numbers 1..35
export const CHUNK = 128;
// audible: 2.2-5.8 kHz, for speakers and FM. dt (dual tone): low enough for walkie-talkies, AM
// radio and phone calls (see channels.mjs), but slower.
export const SPEEDS = {
  normal: "GGWAVE_PROTOCOL_AUDIBLE_NORMAL", fast: "GGWAVE_PROTOCOL_AUDIBLE_FAST", fastest: "GGWAVE_PROTOCOL_AUDIBLE_FASTEST",
  "dt-normal": "GGWAVE_PROTOCOL_DT_NORMAL", "dt-fast": "GGWAVE_PROTOCOL_DT_FAST", "dt-fastest": "GGWAVE_PROTOCOL_DT_FASTEST",
};

export function soundChunks(type, msg) {
  const b64 = Buffer.from(msg).toString("base64"), id = messageId(Buffer.from(msg)).toString("hex");
  const n = Math.ceil(b64.length / CHUNK);
  if (n > DIGITS.length) throw new Error(`payment needs ${n} sound chunks; the limit is ${DIGITS.length}`);
  const t = type === TYPE.PAY_BEEF ? "B" : "E";
  return Array.from({ length: n }, (_, i) => `S${DIGITS[i]}${DIGITS[n - 1]}${t}${id.slice(0, 8)}${b64.slice(i * CHUNK, (i + 1) * CHUNK)}`);
}

export function parseChunk(text) {
  const m = String(text ?? "").match(/^S([1-9a-z])([1-9a-z])([EB])([0-9a-f]{8})([A-Za-z0-9+/=]{1,128})$/);
  if (!m) return null;
  const part = DIGITS.indexOf(m[1]) + 1, of = DIGITS.indexOf(m[2]) + 1;
  return part <= of ? { part, of, type: m[3] === "B" ? TYPE.PAY_BEEF : TYPE.PAY_EF, id: m[4], data: m[5] } : null;
}

// Collects chunks heard from the microphone, in any order, repeats ignored.
export function soundAssembler() {
  const msgs = new Map();
  return {
    add(c) {
      const k = `${c.id}${c.of}${c.type}`;
      let e = msgs.get(k);
      if (!e) msgs.set(k, (e = { got: new Map(), ...c }));
      e.got.set(c.part, c.data);
      const have = e.got.size;
      if (have < c.of) return { have, of: c.of };
      msgs.delete(k);
      const msg = Buffer.from(Array.from({ length: c.of }, (_, i) => e.got.get(i + 1)).join(""), "base64");
      if (messageId(msg).toString("hex").slice(0, 8) !== c.id) return { corrupt: true };
      return { type: c.type, msg };
    },
  };
}

// Pass to the ggwave factory to keep its debug printing off stdout: factory(QUIET)
export const QUIET = { print() {}, printErr() {} };

// Thin wrapper over a loaded ggwave module (browser or Node). Samples are float32.
export function ggwaveCodec(gg, { sampleRate = 48000 } = {}) {
  gg.disableLog?.();
  const p = gg.getDefaultParameters();
  p.sampleRateInp = sampleRate; p.sampleRateOut = sampleRate;
  // separate instances: encoding on the receiving instance breaks a decode in progress
  const tx = gg.init(p), rx = gg.init(p);
  const FRAME = p.samplesPerFrame, frame = new Float32Array(FRAME);
  let fill = 0;
  return {
    sampleRate,
    // returns a Float32Array copy (the module's own view is reused by the next call)
    encode(text, speed = "fast", volume = 25) {
      const raw = gg.encode(tx, text, gg.ProtocolId[SPEEDS[speed]], volume);
      return new Float32Array(new Int8Array(raw).buffer);
    },
    // feed captured samples in any block size; returns the texts decoded so far (often none).
    // ggwave must get whole frames: one short block shifts its frame alignment for good.
    decode(samples) {
      const texts = [];
      for (let i = 0; i < samples.length; ) {
        const take = Math.min(FRAME - fill, samples.length - i);
        frame.set(samples.subarray(i, i + take), fill); fill += take; i += take;
        if (fill < FRAME) break;
        fill = 0;
        const out = gg.decode(rx, new Int8Array(frame.buffer.slice(0)));
        if (out && out.length) texts.push(new TextDecoder().decode(out));
      }
      return texts;
    },
  };
}
