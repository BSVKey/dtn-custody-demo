// Raw-bundle convergence layers for the live checks: hand one BPv7 bundle to a real DTN
// node, or catch the first bundle it forwards, without touching the bundle's bytes.
//   mtcp  uD3TN MTCP: a TCP stream of CBOR byte strings, one bundle each
//   stcp  NASA HDTN STCP: a TCP stream of 4-byte big-endian length + bundle (0 = keepalive)
//   udp   JPL ION UDP CL: one bundle per datagram
//
//   node cl.mjs send <mtcp|stcp|udp> <port> <bundle.hex>
//   node cl.mjs recv <mtcp|stcp|udp> <port> <out.hex> [secs]
import fs from "node:fs";
import net from "node:net";
import dgram from "node:dgram";
import { encode, bstr } from "../cbor.mjs";

const [mode, cl, portS, file, secsS] = process.argv.slice(2);
const port = Number(portS), secs = Number(secsS || 60);
const fail = (m) => { console.error(`[${cl}] ${m}`); process.exit(1); };

if (mode === "send") {
  const data = Buffer.from(fs.readFileSync(file, "utf8").trim(), "hex");
  if (cl === "udp") {
    const s = dgram.createSocket("udp4");
    s.send(data, port, "127.0.0.1", (e) => { s.close(); if (e) fail(e.message); });
  } else {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const frame = cl === "mtcp" ? encode(bstr(data)) : Buffer.concat([len, data]);
    const s = net.connect(port, "127.0.0.1", () => s.write(frame, () => setTimeout(() => s.end(), 2000)));
    s.on("error", (e) => fail(e.message));
  }
} else {
  const done = (bundle) => {
    fs.writeFileSync(file, bundle.toString("hex"));
    console.log(`[${cl}] received a ${bundle.length}-byte bundle on :${port}`);
    process.exit(0);
  };
  setTimeout(() => fail(`nothing received within ${secs} s`), secs * 1000);
  if (cl === "udp") {
    const s = dgram.createSocket("udp4");
    s.on("message", (m) => done(m));
    s.bind(port, "127.0.0.1");
  } else {
    net.createServer((c) => {
      let buf = Buffer.alloc(0);
      c.on("data", (d) => {
        buf = Buffer.concat([buf, d]);
        while (true) {
          if (cl === "stcp") {
            if (buf.length < 4) return;
            const n = buf.readUInt32BE(0);
            if (n === 0) { buf = buf.subarray(4); continue; } // keepalive
            if (buf.length < 4 + n) return;
            return done(buf.subarray(4, 4 + n));
          }
          // MTCP: one CBOR byte-string head, then the bundle
          if (!buf.length) return;
          if (buf[0] >> 5 !== 2) fail("MTCP frames are CBOR byte strings");
          const ai = buf[0] & 31, w = { 24: 1, 25: 2, 26: 4, 27: 8 }[ai] || 0;
          if (buf.length < 1 + w) return;
          const n = ai < 24 ? ai : Number(buf.readUIntBE(1, Math.min(w, 6)));
          if (buf.length < 1 + w + n) return;
          return done(buf.subarray(1 + w, 1 + w + n));
        }
      });
    }).listen(port, "127.0.0.1");
  }
}
