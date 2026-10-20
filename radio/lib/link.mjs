// A simulated LoRa link between two radios: seeded packet loss, half duplex, and time on air
// counted from the modem settings. Both ends look like a real radio endpoint:
//   { send(frame) -> Promise, onFrame(cb), close(), stats }
// timeScale 0 delivers at once (tests); 1 waits the real time on air.
import { airtimeMs, PRESETS } from "./frame.mjs";

function prng(seed) {
  let s = seed >>> 0 || 1;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
}

export function loraLink({ loss = 0, preset = "LongFast", modem, seed = 1, timeScale = 0, drop } = {}) {
  const radio = modem ?? PRESETS[preset];
  if (!radio) throw new Error(`unknown preset ${preset}`);
  const rand = prng(seed);
  const stats = { sent: 0, lost: 0, delivered: 0, bytes: 0, airtimeMs: 0 };
  let busyUntil = 0;
  const ends = [makeEnd("a"), makeEnd("b")];
  function makeEnd(name) {
    const handlers = [];
    let closed = false;
    return {
      name, handlers, stats,
      onFrame(cb) { handlers.push(cb); },
      close() { closed = true; },
      get closed() { return closed; },
      async send(frame) {
        if (closed) return;
        const peer = ends[name === "a" ? 1 : 0];
        const air = airtimeMs(frame.length, radio);
        stats.sent++; stats.bytes += frame.length; stats.airtimeMs += air;
        // one shared channel: a frame waits for the one before it to finish
        const now = Date.now(), start = Math.max(now, busyUntil), end = start + air * timeScale;
        busyUntil = end;
        if (end > now) await new Promise((r) => setTimeout(r, end - now));
        const lost = drop ? drop(frame, stats.sent) : rand() < loss;
        if (lost) { stats.lost++; return; }
        stats.delivered++;
        setImmediate(() => { if (!peer.closed) for (const h of peer.handlers) h(Buffer.from(frame)); });
      },
    };
  }
  return { a: ends[0], b: ends[1], stats, radio };
}
