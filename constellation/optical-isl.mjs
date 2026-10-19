// Custody receipts across optical inter-satellite links, modeled on public optical ISL
// parameters (not on any operator's proprietary system).
//
//   node constellation/optical-isl.mjs [--class 10G] [--acq 30] [--duration 600] [--seed 1]
//                                      [--bundle 1048576] [--load 0.8] [--samples 400] [--json out.json]
//
// Link classes and timings, from ESA ESTOL v3.1 (ESA-CSC-T-SP-0001, 24 June 2026), which
// builds on the SDA Optical Communications Terminal standard (SDA 9100-001-09, v4.0.0):
//   2.5G   2.5G IM/DD OOK, user net data rate up to 2.221 Gbps   (ESTOL-OOK-41010)
//   10G    10G IM/DD OOK, 10.0 Gbps                               (ESTOL-OOK-43010)
//   100G   100G DP-QPSK, 99.5328 Gbps                             (ESTOL-HCO-31010)
//   PAT acquisition (warm start) shall be below 60 s, should be below 30 s (ESTOL-PAT-00030/40);
//   re-acquisition below 10 s, automatic until the scheduled link end (ESTOL-PAT-00050/60).
//
// Topology: origin ipn:5.0 feeds custodian A (101); A -> B (102) in plane 1; B -> C (103)
// across planes until the handoff, then B -> C2 (203) after a fresh acquisition; C and C2
// -> D (104) in plane 2; D delivers to the ground verifier. C2 is a relay that does not run
// custody (an unaware node), so bundles routed through it must show a gap. In-plane and
// cross-plane links fade at random (Poisson, one per 120 s on average) and re-acquire in
// 2 to 10 s. The convergence layer (TCPCLv4, RFC 9174, or LTP, RFC 5326) is modeled as
// reliable: a transmission cut by an outage is resent when the link is back.
//
// Every bundle is scheduled through the links. Every custodian folds every bundle it holds
// into a per-contact batch (StreamMerkle, content-bound leaf over identity and payload
// hash) and signs one COSE_Sign1 batch receipt when the contact ends. A sample of bundles
// is also carried as real BPv7 bytes with per-bundle block 224 receipts (fast path). One
// sampled bundle is tampered with by custodian C (payload changed, CRCs recomputed). The
// ground verifier audits the sample both ways.
import { writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { encode, decode, bstr } from "../transport/bpv7/cbor.mjs";
import { encodeBundle, BLOCK, CRC32C } from "../transport/bpv7/bundle.mjs";
import { verifyBundleV2 } from "../transport/bpv7/receipt-v2.mjs";
import { BundleReceiver, receiveBundle, stampReceivedParts } from "../transport/bpv7/fast-stamp.mjs";
import { sign1, verify1 } from "../transport/bpv7/cose.mjs";
import { StreamMerkle, leafOf } from "../agent/lib/stream-merkle.mjs";
import { verifyProof } from "../agent/lib/merkle.mjs";
import { genKeypair } from "../agent/lib/keys.mjs";

const arg = (n, d) => { const i = process.argv.indexOf(n); return i > 0 ? process.argv[i + 1] : d; };
const CLASSES = {
  "2.5G": { rate: 2.221e9, name: "2.5G IM/DD OOK (ESTOL-OOK-41010 upper bound, SDA OCT class)" },
  "10G": { rate: 10.0e9, name: "10G IM/DD OOK (ESTOL-OOK-43010)" },
  "100G": { rate: 99.5328e9, name: "100G DP-QPSK (ESTOL-HCO-31010)" },
};
const CLS = arg("--class", "10G"), RATE = CLASSES[CLS].rate;
const ACQ = Number(arg("--acq", 30)), DUR = Number(arg("--duration", 600)), SEED = Number(arg("--seed", 1));
const SIZE = Number(arg("--bundle", 1048576)), LOAD = Number(arg("--load", 0.8)), SAMPLES = Number(arg("--samples", 400));
const JSON_OUT = arg("--json", null);
const HANDOFF = DUR / 2, FADE_MEAN_GAP = 120, FADE_MIN = 2, FADE_MAX = 10;
const DTN_T0 = 812345678901; // DTN time (ms) at simulation time 0

let s = SEED >>> 0; // mulberry32
const rnd = () => { s = (s + 0x6d2b79f5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };

// ---- nodes and links ----------------------------------------------------------------
const ORIGIN = "ipn:5.0", SRC = "ipn:5.1";
const node = (eid, custodian = true) => ({ eid, custodian, kp: custodian ? genKeypair() : null, contacts: new Map(), held: [] });
const N = { A: node("ipn:101.0"), B: node("ipn:102.0"), C: node("ipn:103.0"), C2: node("ipn:203.0", false), D: node("ipn:104.0") };
const keys = Object.fromEntries(Object.values(N).filter((x) => x.custodian).map((x) => [x.eid, x.kp.pub]));

// Up intervals [start, end) with random fades removed.
function upIntervals(start, end, fades) {
  const out = []; let t = start;
  if (fades) {
    let f = start + -Math.log(1 - rnd()) * FADE_MEAN_GAP;
    while (f < end) {
      const d = FADE_MIN + rnd() * (FADE_MAX - FADE_MIN);
      if (f > t) out.push([t, f]);
      t = Math.min(end, f + d);
      f = t + -Math.log(1 - rnd()) * FADE_MEAN_GAP;
    }
  }
  if (t < end) out.push([t, end]);
  return out;
}
const link = (from, to, up, kind) => ({ from, to, up, kind, freeAt: 0, sent: 0, resent: 0 });
const END = DUR * 10; // links stay up after the traffic stops so queues drain
const L = {
  SA: link(null, N.A, [[0, END]], "feeder"),
  AB: link(N.A, N.B, upIntervals(0, END, true), "in-plane"),
  BC: link(N.B, N.C, upIntervals(0, HANDOFF, true), "cross-plane"),
  BC2: link(N.B, N.C2, upIntervals(HANDOFF + ACQ, END, true), "cross-plane (after handoff and acquisition)"),
  CD: link(N.C, N.D, upIntervals(0, END, true), "in-plane"),
  C2D: link(N.C2, N.D, upIntervals(0, END, true), "in-plane"),
  DG: link(N.D, null, [[0, END]], "delivery"),
};

// Send one bundle of `bits` on a link no earlier than `ready`. Returns { start, end, contact }.
function send(l, ready, bits) {
  const tx = bits / RATE;
  let t = Math.max(ready, l.freeAt);
  for (let i = 0; i < l.up.length; i++) {
    const [a, b] = l.up[i];
    if (t >= b) continue;
    if (t < a) t = a;
    if (t + tx <= b) { l.freeAt = t + tx; l.sent++; return { start: t, end: t + tx, contact: i }; }
    l.resent++; // cut by a fade or the end of the link: resent on the next up interval
    t = b;
  }
  return null;
}

// ---- custody state -------------------------------------------------------------------
const ph = (seq) => createHash("sha256").update(Buffer.from(`payload ${seq}`)).digest(); // synthetic, unsampled bundles carry no bytes
const leafFor = (identity, payloadHash) => leafOf(encode([identity, bstr(payloadHash)]));
function hold(n, inLink, contact, seq, identity, payloadHash, at, watch) {
  const key = `${inLink.from ? inLink.from.eid : ORIGIN}#${contact}`;
  let c = n.contacts.get(key);
  if (!c) { c = { prevHop: inLink.from ? inLink.from.eid : ORIGIN, contact, from: at, to: at, tree: new StreamMerkle(), index: new Map(), contactId: `${n.eid}/${key}`, window: inLink.up[contact] }; n.contacts.set(key, c); }
  const i = c.tree.add(leafFor(identity, payloadHash), { watch });
  if (watch) c.index.set(seq, i);
  c.to = Math.max(c.to, at);
}

// ---- traffic -------------------------------------------------------------------------
const bits = SIZE * 8, gap = bits / (RATE * LOAD), total = Math.floor(DUR / gap);
const sampleEvery = Math.max(1, Math.floor(total / SAMPLES));
const TAMPER = sampleEvery * 7; // one early sampled bundle that goes through C
const samples = new Map();
const timing = { held: [], e2e: [], stampUs: [], viaC2: 0, undelivered: 0 };
const heldArr = new Float64Array(Math.floor(DUR / (SIZE * 8 / (RATE * LOAD))) + 1), heldDep = new Float64Array(heldArr.length); let nHeld = 0;
const mkBytes = (seq) => {
  const p = Buffer.alloc(SIZE); for (let i = 0; i < SIZE; i += 4096) p.writeUInt32BE(seq, i);
  return encodeBundle({ primary: { crcType: CRC32C, dest: "ipn:2.1", source: SRC, created: [DTN_T0 + Math.floor((seq * gap) * 1000), seq], lifetime: 86400000 },
    blocks: [{ type: BLOCK.PAYLOAD, number: 1, crcType: CRC32C, data: p }] });
};
const ms = (t) => DTN_T0 + Math.round(t * 1000);

const t0 = process.hrtime.bigint();
for (let seq = 0; seq < total; seq++) {
  const created = seq * gap, identity = [SRC, [DTN_T0 + Math.floor(created * 1000), seq]];
  const sampled = seq % sampleEvery === 0;
  let bytes = sampled ? mkBytes(seq) : null;
  let payloadHash = sampled ? createHash("sha256").update(bytes.subarray(bytes.length - SIZE - 6, bytes.length - 6)).digest() : ph(seq);
  const path = [];
  // hop by hop: link, receiving node
  const hops = [[L.SA, N.A], [L.AB, N.B], null, null, [L.DG, null]];
  let ready = created, prev = ORIGIN;
  let x = send(L.SA, ready, bits);
  const stampAt = (n, inLink, r) => {
    path.push(n.eid);
    if (!n.custodian) return;
    hold(n, inLink, r.contact, seq, identity, payloadHash, r.end, sampled);
    if (sampled) {
      if (seq === TAMPER && n === N.C) { // custodian C changes the payload and recomputes the CRCs
        const p = Buffer.alloc(SIZE, 0xee);
        bytes = encodeBundle({ primary: { crcType: CRC32C, dest: "ipn:2.1", source: SRC, created: identity[1], lifetime: 86400000 },
          blocks: [...receiveBundleBlocks(bytes), { type: BLOCK.PAYLOAD, number: 1, crcType: CRC32C, data: p }] });
        payloadHash = createHash("sha256").update(p).digest();
      }
      // Incremental receive in 64 KiB convergence-layer segments; time only what follows the last one.
      const rx = new BundleReceiver(), SEG = 65536;
      let k = 0;
      for (; k + SEG < bytes.length; k += SEG) rx.push(bytes.subarray(k, k + SEG));
      const t = process.hrtime.bigint();
      rx.push(bytes.subarray(k));
      const parts = stampReceivedParts(rx.finish(), { kp: n.kp, eid: n.eid }, { prevHop: prev, receivedAt: ms(r.end), forwardedAt: ms(r.end) });
      timing.stampUs.push(Number(process.hrtime.bigint() - t) / 1e3); // ready for a gathering write
      bytes = Buffer.concat(parts);
    }
  };
  stampAt(N.A, L.SA, x); prev = N.A.eid;
  x = send(L.AB, x.end, bits); stampAt(N.B, L.AB, x); prev = N.B.eid;
  const atB = x.end;
  let viaC = send(L.BC, atB, bits), nextNode = N.C, inL = L.BC, out = L.CD;
  if (!viaC) { viaC = send(L.BC2, atB, bits); nextNode = N.C2; inL = L.BC2; out = L.C2D; timing.viaC2++; }
  if (!viaC) { timing.undelivered++; continue; }
  heldArr[nHeld] = atB; heldDep[nHeld++] = viaC.start;
  x = viaC; stampAt(nextNode, inL, x); prev = nextNode.eid;
  x = send(out, x.end, bits); stampAt(N.D, out, x); prev = N.D.eid;
  x = send(L.DG, x.end, bits);
  timing.e2e.push(x.end - created);
  if (sampled) samples.set(seq, { identity, bytes, path, payloadHash });
}
const simMs = Number(process.hrtime.bigint() - t0) / 1e6;
function receiveBundleBlocks(b) { // extension blocks of a bundle, for the tamper case
  const rx = receiveBundle(b);
  return rx.blocks.map((x) => ({ type: x.type, number: x.number, crcType: CRC32C, flags: 1, data: x.data }));
}

// ---- close every contact: one batch receipt per node per contact -----------------------
const batchFields = (n, c, root) => encode(new Map([[1, c.prevHop], [2, n.eid], [5, ms(c.from)], [6, ms(c.to)], [8, c.tree.count], [9, bstr(root)], [10, c.contactId]]));
const receipts = []; const closeUs = [];
for (const n of Object.values(N)) for (const c of n.contacts.values()) {
  const t = process.hrtime.bigint();
  const root = c.tree.root();
  c.receipt = decode(encode(sign1(n.kp.priv, batchFields(n, c, root))));
  closeUs.push(Number(process.hrtime.bigint() - t) / 1e3);
  c.root = root;
  receipts.push({ node: n.eid, prevHop: c.prevHop, count: c.tree.count, bytes: encode(c.receipt).length });
}

// ---- audit the sample at the ground ------------------------------------------------------
const per = { complete: 0, gaps: 0, gapViaC2: 0, failed: 0, reasons: {} };
const bat = { complete: 0, gaps: 0, gapViaC2: 0, contentMismatch: 0, badSig: 0, proofsChecked: 0 };
for (const [seq, smp] of samples) {
  // per-bundle receipts in block 224
  const v = verifyBundleV2(smp.bytes, { keys, origin: ORIGIN, lastNode: N.D.eid });
  if (!v.ok) { per.failed++; per.reasons[v.reason] = (per.reasons[v.reason] ?? 0) + 1; }
  else if (v.complete) per.complete++;
  else { per.gaps++; if (v.gaps.some((g) => g.lastUnsigned === N.C2.eid)) per.gapViaC2++; }
  // batch receipts: ask every custodian for its receipt and proof for this bundle
  const received = createHash("sha256").update(smp.bytes.subarray(smp.bytes.length - SIZE - 6, smp.bytes.length - 6)).digest();
  const leaf = leafFor(smp.identity, received).toString("hex");
  const entries = [];
  for (const n of Object.values(N)) for (const c of n.contacts.values()) {
    if (!c.index.has(seq)) continue;
    const ok = verify1(c.receipt, keys[n.eid]);
    if (!ok.ok) { bat.badSig++; continue; }
    const f = decode(ok.payload), idx = c.index.get(seq);
    bat.proofsChecked++;
    entries.push({ thisHop: f.get(2), prevHop: f.get(1), from: f.get(5), inTree: verifyProof(leaf, c.tree.proof(idx), idx, f.get(9).toString("hex")) });
  }
  // Walk the chain by prevHop -> thisHop (batch receipts carry no per-bundle times).
  let prevEid = ORIGIN, gapHere = false, mismatch = entries.some((e) => !e.inTree);
  const left = [...entries];
  while (left.length) {
    let i = left.findIndex((e) => e.prevHop === prevEid);
    if (i < 0) { // unsigned stretch: continue from the receipt whose prevHop no remaining receipt signed for
      i = left.findIndex((e) => !left.some((o) => o.thisHop === e.prevHop));
      if (i < 0) i = 0;
      gapHere = true; if (left[i].prevHop === N.C2.eid) bat.gapViaC2++;
    }
    prevEid = left[i].thisHop; left.splice(i, 1);
  }
  if (prevEid !== N.D.eid) gapHere = true;
  if (mismatch) bat.contentMismatch++;
  else if (gapHere) bat.gaps++;
  else bat.complete++;
}

// ---- report ----------------------------------------------------------------------------
const q = (xs, p) => { const s2 = [...xs].sort((a, b) => a - b); return s2[Math.min(s2.length - 1, Math.floor(p * s2.length))]; };
let peak = 0; { const a = heldArr.slice(0, nHeld).sort(), d = heldDep.slice(0, nHeld).sort(); let i = 0, j = 0, cur = 0; while (i < a.length) { if (d[j] <= a[i]) { cur--; j++; } else { cur++; i++; peak = Math.max(peak, cur); } } }
const delivered = timing.e2e.length;
const lastEnd = Math.max(...Object.values(L).map((l) => l.freeAt));
// fades that began while traffic was flowing (links stay up afterwards only so queues drain)
const fadeCount = Object.values(L).reduce((a, l) => a + l.up.slice(1).filter(([st], i) => l.up[i][1] < lastEnd && st > 0).length, 0);
const preHandoff = timing.e2e.slice(0, Math.floor(HANDOFF / gap));
const blockBytes = (hops) => 168 + 156 * (hops - 1);
const R = {
  class: CLS, className: CLASSES[CLS].name, rateBps: RATE, acquisitionS: ACQ, durationS: DUR, handoffAtS: HANDOFF, seed: SEED,
  bundleBytes: SIZE, load: LOAD, bundles: total, delivered, undelivered: timing.undelivered, viaC2: timing.viaC2,
  fades: fadeCount, resent: Object.values(L).reduce((a, l) => a + l.resent, 0),
  peakHeldAtB: peak, peakHeldAtBBytes: peak * SIZE,
  lastDeliveryS: lastEnd, e2ePreHandoffMedianS: q(preHandoff, 0.5), e2ePreHandoffMaxS: q(preHandoff, 1), e2eMedianS: q(timing.e2e, 0.5), e2eP99S: q(timing.e2e, 0.99), e2eMaxS: q(timing.e2e, 1),
  batchReceipts: receipts.length, batchReceiptBytes: receipts.reduce((a, r) => a + r.bytes, 0),
  perBundleReceiptBytesAll: (total - timing.viaC2) * blockBytes(4) + timing.viaC2 * blockBytes(3),
  closeUsMedian: q(closeUs, 0.5), closeUsMax: q(closeUs, 1), stampUsMedian: q(timing.stampUs, 0.5),
  sampled: samples.size, perBundleAudit: per, batchAudit: bat, simMs,
  links: Object.fromEntries(Object.entries(L).map(([k, l]) => [k, { kind: l.kind, upIntervals: l.up.length, sent: l.sent, resent: l.resent }])),
};
const f = (x, d = 0) => Number(x).toLocaleString("en-US", { maximumFractionDigits: d, minimumFractionDigits: d });
console.log(`### Optical ISL run: ${CLASSES[CLS].name}, acquisition ${ACQ} s, seed ${SEED}`);
console.log();
console.log(`| | |\n|---|---|`);
console.log(`| Link rate | ${f(RATE / 1e9, 4)} Gbps, load ${LOAD * 100}% |`);
console.log(`| Simulated time | ${DUR} s of traffic; cross-plane handoff at ${HANDOFF} s, new link up after ${ACQ} s acquisition |`);
console.log(`| Bundles | ${f(total)} of ${f(SIZE)} B; delivered ${f(delivered)}; ${f(timing.viaC2)} routed through the unaware relay after the handoff |`);
console.log(`| Link events | ${fadeCount} fades (re-acquired in ${FADE_MIN} to ${FADE_MAX} s), ${f(R.resent)} transmissions cut and resent, 1 handoff |`);
console.log(`| Held at B across the handoff (peak) | ${f(peak)} bundles, ${f(peak * SIZE / 1e9, 2)} GB |`);
console.log(`| End-to-end delay before the handoff | median ${f(R.e2ePreHandoffMedianS, 3)} s, max ${f(R.e2ePreHandoffMaxS, 2)} s |`);
console.log(`| End-to-end delay, all bundles (includes the handoff backlog draining at 20% spare capacity) | median ${f(R.e2eMedianS, 3)} s, p99 ${f(R.e2eP99S, 2)} s, max ${f(R.e2eMaxS, 2)} s |`);
console.log(`| Batch receipts signed (one per node per contact) | ${receipts.length}, ${f(R.batchReceiptBytes)} B in total |`);
console.log(`| Per-bundle receipts the same traffic would carry | ${f(R.perBundleReceiptBytesAll)} B (block 224 at the last hop, summed over bundles) |`);
console.log(`| Batch close (root + sign), median / max | ${f(R.closeUsMedian, 1)} us / ${f(R.closeUsMax, 1)} us |`);
console.log(`| Per-bundle stamp on the sample (fast path, after the last 64 KiB segment), median | ${f(R.stampUsMedian, 1)} us per hop |`);
console.log(`| Audited sample | ${samples.size} bundles |`);
console.log(`| Per-bundle audit (block 224) | complete ${per.complete}, gap ${per.gaps} (gap at the unaware relay: ${per.gapViaC2}), failed ${per.failed} ${JSON.stringify(per.reasons)} |`);
console.log(`| Batch audit (receipt + inclusion proof per hop) | complete ${bat.complete}, gap ${bat.gaps} (at the unaware relay: ${bat.gapViaC2}), content changed ${bat.contentMismatch}, bad signatures ${bat.badSig}, proofs checked ${bat.proofsChecked} |`);
console.log(`| Run time | ${f(simMs / 1000, 1)} s |`);
if (JSON_OUT) writeFileSync(JSON_OUT, JSON.stringify(R, null, 1));
