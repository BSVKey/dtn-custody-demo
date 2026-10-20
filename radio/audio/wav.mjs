// Minimal WAV read/write: mono 16-bit PCM out; 8/16/24/32-bit PCM or 32-bit float in (first
// channel of a multi-channel file). Enough to feed a transmitter and to decode a recording.
export function writeWav(samples, sampleRate) {
  const n = samples.length, b = Buffer.alloc(44 + n * 2);
  b.write("RIFF", 0); b.writeUInt32LE(36 + n * 2, 4); b.write("WAVE", 8);
  b.write("fmt ", 12); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22);
  b.writeUInt32LE(sampleRate, 24); b.writeUInt32LE(sampleRate * 2, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34);
  b.write("data", 36); b.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) b.writeInt16LE(Math.round(Math.max(-1, Math.min(1, samples[i])) * 32767), 44 + i * 2);
  return b;
}

export function readWav(buf) {
  const b = Buffer.from(buf);
  if (b.toString("ascii", 0, 4) !== "RIFF" || b.toString("ascii", 8, 12) !== "WAVE") throw new Error("not a WAV file");
  let fmt = null, off = 12;
  while (off + 8 <= b.length) {
    const id = b.toString("ascii", off, off + 4), size = b.readUInt32LE(off + 4), body = off + 8;
    if (id === "fmt ") fmt = { format: b.readUInt16LE(body), channels: b.readUInt16LE(body + 2), sampleRate: b.readUInt32LE(body + 4), bits: b.readUInt16LE(body + 14) };
    if (id === "data") {
      if (!fmt) throw new Error("WAV data before format");
      const { format, channels, bits, sampleRate } = fmt, step = (bits / 8) * channels, n = Math.floor(Math.min(size, b.length - body) / step);
      const out = new Float32Array(n);
      // format 3 is IEEE float; 0xFFFE (extensible) keeps its real type in a sub-format GUID
      const float = format === 3 || (format === 0xfffe && b.readUInt16LE(off + 8 + 24) === 3);
      for (let i = 0; i < n; i++) {
        const p = body + i * step;
        out[i] = float ? b.readFloatLE(p) : bits === 8 ? (b[p] - 128) / 128 : bits === 16 ? b.readInt16LE(p) / 32768 : bits === 24 ? b.readIntLE(p, 3) / 8388608 : b.readInt32LE(p) / 2147483648;
      }
      return { samples: out, sampleRate };
    }
    off = body + size + (size & 1);
  }
  throw new Error("no audio data in WAV file");
}
