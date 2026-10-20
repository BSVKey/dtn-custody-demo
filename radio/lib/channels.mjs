// Audio channels a payment can ride on as sound, and which ggwave tones survive each one.
//
// Measured in simulation (test/radio-channels.test.mjs): the "audible" tones sit at about
// 2.2-5.8 kHz and pass FM and AM audio but not a walkie-talkie or a phone call, which keep
// roughly 300-3,000 Hz. ggwave's dual-tone (DT) protocols sit low enough for all of them.
//
// The simulation is a band-pass filter plus noise. Real links add things it does not: FM
// pre-emphasis, AGC and limiters at a broadcast station, squelch tails and push-to-talk delay on
// a walkie-talkie, codec compression on a phone call. These profiles are a starting point to
// test with real equipment, not a result.
export const CHANNELS = {
  speaker: { label: "Phone speaker to phone microphone", band: [100, 16000], speed: "fast", leadInS: 0.3 },
  fm: { label: "FM broadcast audio", band: [50, 15000], speed: "fastest", leadInS: 1 },
  am: { label: "AM broadcast audio", band: [100, 4500], speed: "dt-fastest", leadInS: 1 },
  walkie: { label: "Walkie-talkie (FRS/GMRS, narrow FM voice)", band: [300, 3000], speed: "dt-fastest", leadInS: 1.5 },
  phone: { label: "Phone call", band: [300, 3400], speed: "dt-fastest", leadInS: 0.5 },
};

// RBJ cookbook biquads, cascaded 4 times each side: a steep band-pass like a voice channel.
function biquad(type, f, sr, q = Math.SQRT1_2) {
  const w = (2 * Math.PI * f) / sr, a = Math.sin(w) / (2 * q), c = Math.cos(w);
  const [b0, b1, b2] = type === "lp" ? [(1 - c) / 2, 1 - c, (1 - c) / 2] : [(1 + c) / 2, -(1 + c), (1 + c) / 2];
  const a0 = 1 + a;
  return [b0 / a0, b1 / a0, b2 / a0, (-2 * c) / a0, (1 - a) / a0];
}
function filter(x, [b0, b1, b2, a1, a2]) {
  const y = new Float32Array(x.length);
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  for (let i = 0; i < x.length; i++) { const v = b0 * x[i] + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2; x2 = x1; x1 = x[i]; y2 = y1; y1 = v; y[i] = v; }
  return y;
}

// samples through a channel: band limits, gain, noise, and hard clipping at full scale
export function simulateChannel(samples, name, { sampleRate = 48000, gain = 0.5, noise = 0.03, seed = 1 } = {}) {
  const ch = CHANNELS[name];
  if (!ch) throw new Error(`unknown channel ${name}`);
  let y = samples;
  for (let i = 0; i < 4; i++) { y = filter(y, biquad("hp", ch.band[0], sampleRate)); y = filter(y, biquad("lp", Math.min(ch.band[1], sampleRate * 0.45), sampleRate)); }
  let s = seed >>> 0 || 1;
  const rand = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
  const out = new Float32Array(y.length);
  for (let i = 0; i < y.length; i++) out[i] = Math.max(-1, Math.min(1, y[i] * gain + (rand() - 0.5) * noise));
  return out;
}
