// Time a custodian adds before it can forward a bundle, before and after the fast path
// (transport/bpv7/fast-stamp.mjs). Same wire bytes in every case (checked below).
//
//   node bench/latency.mjs [--json out.json] [--label "..."]
//
// Latency is measured from the moment the last convergence-layer segment of the bundle
// arrives to the moment the outgoing bundle is ready to hand to the convergence layer.
//   before        stampBundleV2 on the complete bundle (decode + CRC checks, hash, sign, re-encode)
//   splice        receive the complete bundle in one call, then stampReceived (no incremental work)
//   incremental   segments were hashed and CRC-checked as they arrived; time only the last
//                 segment, finish(), and stampReceivedParts (a gathering write, payload not copied)
// Medians of many runs, single thread.
import os from "node:os";
import { writeFileSync } from "node:fs";
import { encodeBundle, BLOCK, CRC32C } from "../transport/bpv7/bundle.mjs";
import { stampBundleV2 } from "../transport/bpv7/receipt-v2.mjs";
import { BundleReceiver, receiveBundle, stampReceived, stampReceivedParts } from "../transport/bpv7/fast-stamp.mjs";
import { sign1Encoded } from "../transport/bpv7/cose.mjs";
import { genKeypair } from "../agent/lib/keys.mjs";

const arg = (n, d) => { const i = process.argv.indexOf(n); return i > 0 ? process.argv[i + 1] : d; };
const LABEL = arg("--label", `${os.arch()} ${os.platform()}`), JSON_OUT = arg("--json", null);
const SIZES = [1024, 65536, 1048576], NAME = { 1024: "1 KiB", 65536: "64 KiB", 1048576: "1 MiB" };
const SEGMENTS = [1472, 65536]; // UDP / LTP segment over a 1500-byte MTU; a 64 KiB TCPCLv4 segment
const relay = { kp: genKeypair(), eid: "ipn:20.0" };
const o = { prevHop: "ipn:5.0", receivedAt: 1, forwardedAt: 2 };
const now = () => process.hrtime.bigint();
const us = (a, b) => Number(b - a) / 1e3;
const median = (xs) => { const s = [...xs].sort((a, b) => a - b); return s[s.length >> 1]; };
const runs = (size) => (size >= 1048576 ? 200 : size >= 65536 ? 1000 : 5000);
const fmt = (x) => (x >= 1000 ? `${(x / 1000).toFixed(2)} ms` : x >= 10 ? `${x.toFixed(1)} us` : `${x.toFixed(2)} us`);

const mk = (n) => {
  const p = Buffer.alloc(n); for (let i = 0; i < n; i++) p[i] = (i * 37) & 0xff;
  return encodeBundle({ primary: { crcType: CRC32C, dest: "ipn:2.1", source: "ipn:5.1", created: [812345678901, 7], lifetime: 86400000 },
    blocks: [{ type: BLOCK.PAYLOAD, number: 1, crcType: CRC32C, data: p }] });
};

const R = { label: LABEL, when: new Date().toISOString(), node: process.version, cpu: os.cpus()[0]?.model?.trim(), rows: [] };
// The signature alone, the floor of any per-bundle receipt.
{ const p = Buffer.alloc(96, 1); const xs = []; for (let i = 0; i < 5000; i++) { const t = now(); sign1Encoded(relay.kp.priv, p); xs.push(us(t, now())); } R.signUs = median(xs); }

for (const size of SIZES) {
  const b0 = mk(size), n = runs(size);
  const want = stampBundleV2(b0, relay, o);
  if (!stampReceived(receiveBundle(b0), relay, o).equals(want)) throw new Error("splice output differs");
  const row = { size, bundleBytes: b0.length, headBytes: stampReceivedParts(receiveBundle(b0), relay, o)[0].length };
  let xs = [];
  for (let i = 0; i < n; i++) { const t = now(); stampBundleV2(b0, relay, o); xs.push(us(t, now())); }
  row.beforeUs = median(xs);
  xs = [];
  for (let i = 0; i < n; i++) { const t = now(); stampReceived(receiveBundle(b0), relay, o); xs.push(us(t, now())); }
  row.spliceUs = median(xs);
  row.incremental = {};
  for (const seg of SEGMENTS) {
    const segs = []; for (let i = 0; i < b0.length; i += seg) segs.push(b0.subarray(i, i + seg));
    const onPath = [], total = [];
    for (let i = 0; i < n; i++) {
      const t0 = now(), rx = new BundleReceiver();
      for (let k = 0; k < segs.length - 1; k++) rx.push(segs[k]);   // while the bundle arrives
      const t1 = now();
      rx.push(segs[segs.length - 1]);
      const parts = stampReceivedParts(rx.finish(), relay, o);
      const t2 = now();
      if (i === 0 && !Buffer.concat(parts).equals(want)) throw new Error("incremental output differs");
      onPath.push(us(t1, t2)); total.push(us(t0, t2));
    }
    row.incremental[seg] = { segments: segs.length, onPathUs: median(onPath), cpuUs: median(total) };
  }
  R.rows.push(row);
}

const out = [];
const p = (s = "") => out.push(s);
p(`### Custodian latency: ${LABEL}`);
p();
p(`${R.when}, ${R.cpu}, Node ${R.node}, single thread, medians. Ed25519 COSE_Sign1 sign alone: ${fmt(R.signUs)}.`);
p();
p("| Bundle | Before: stampBundleV2 | Splice (no incremental work) | Incremental, 1,472 B segments: added after last byte | CPU per bundle, incl. while arriving | Incremental, 64 KiB segments: added after last byte | CPU per bundle |");
p("|---|---|---|---|---|---|---|");
for (const r of R.rows) {
  const a = r.incremental[1472], b = r.incremental[65536];
  p(`| ${NAME[r.size]} | ${fmt(r.beforeUs)} | ${fmt(r.spliceUs)} | ${fmt(a.onPathUs)} (${(r.beforeUs / a.onPathUs).toFixed(1)}x less) | ${fmt(a.cpuUs)} | ${fmt(b.onPathUs)} (${(r.beforeUs / b.onPathUs).toFixed(1)}x less) | ${fmt(b.cpuUs)} |`);
}
p();
// Signing while the convergence layer starts sending: the payload block must be last (RFC 9171
// section 4.1) and block 224 precedes it, so only the bytes before block 224 can go out early.
const hb = R.rows[0].headBytes;
p(`Signing while the convergence layer starts sending: only the ${hb} B before block 224 (here the primary block) can leave before the signature exists, ${(hb * 8 / 1e10 * 1e9).toFixed(1)} ns at 10 Gbps and ${(hb * 8 / 1e11 * 1e9).toFixed(1)} ns at 100 Gbps, against a ${fmt(R.signUs)} signature.`);
console.log(out.join("\n"));
if (JSON_OUT) writeFileSync(JSON_OUT, JSON.stringify(R, null, 1));
