// What does the Custody Receipt Block cost a high-throughput operator?
//
// Measures, with the repository's own code, per-bundle version 2 receipts (one COSE_Sign1
// per custodian per bundle, in block 224) against batched receipts (one COSE_Sign1 per
// node per batch window, over a Merkle root of the bundles it held), then turns the
// measured costs into bytes per GB, CPU per link rate and latency per contact.
//
//   node bench/overhead.mjs                       print the report
//   node bench/overhead.mjs --json out.json       also write the raw measurements
//   node bench/overhead.mjs --max-leaves 100000   cap the largest batch measured (for slow or emulated CPUs)
//   node bench/overhead.mjs --label "x86 native"  label for the report header
//
// Every figure printed is either measured here or computed from a measured figure by
// the arithmetic shown in docs/overhead-benchmark.md. Single thread throughout.
import os from "node:os";
import { writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { encode, decode, bstr } from "../transport/bpv7/cbor.mjs";
import { encodeBundle, BLOCK, CRC32C } from "../transport/bpv7/bundle.mjs";
import { stampBundleV2, verifyBundleV2, bundleIdentity } from "../transport/bpv7/receipt-v2.mjs";
import { decodeBundle } from "../transport/bpv7/bundle.mjs";
import { sign1, verify1 } from "../transport/bpv7/cose.mjs";
import { genKeypair } from "../agent/lib/keys.mjs";
import { leafHash, buildTree, proof, verifyProof } from "../agent/lib/merkle.mjs";
import { batchReceipt } from "../agent/lib/batch.mjs";

const arg = (name, dflt) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : dflt; };
const MAX_LEAVES = Number(arg("--max-leaves", 1_000_000));
const LABEL = arg("--label", `${os.arch()} ${os.platform()}`);
const JSON_OUT = arg("--json", null);
const MIN_MS = Number(arg("--min-ms", 500));

const time = (fn, minMs = MIN_MS, minIter = 1) => {
  let n = 0, el = 0;
  const t0 = process.hrtime.bigint();
  while (el < minMs || n < minIter) { fn(); n++; el = Number(process.hrtime.bigint() - t0) / 1e6; }
  return { perSec: (n / el) * 1000, us: (el * 1000) / n, n };
};
const fmt = (x, d = 0) => Number(x).toLocaleString("en-US", { maximumFractionDigits: d, minimumFractionDigits: d });
const sig = (x) => (x >= 100 ? fmt(x, 0) : x >= 10 ? fmt(x, 1) : x >= 1 ? fmt(x, 2) : x >= 0.01 ? fmt(x, 3) : x.toExponential(1));
const dur = (us) => (us < 1000 ? `${sig(us)} us` : us < 1e6 ? `${sig(us / 1000)} ms` : `${sig(us / 1e6)} s`);

const SIZES = [1024, 65536, 1048576];
const SIZE_NAME = { 1024: "1 KiB", 65536: "64 KiB", 1048576: "1 MiB" };
const RATES = [1e8, 1e9, 1e10, 1e11];
const RATE_NAME = { 1e8: "100 Mbps", 1e9: "1 Gbps", 1e10: "10 Gbps", 1e11: "100 Gbps" };
const WINDOWS = [1, 60];        // batch window, seconds: close a batch every second, or once per 60 s contact
const GB = 1e9;                 // payload bytes per "GB"

const relay = { kp: genKeypair(), eid: "ipn:20.0" };
const keys = { [relay.eid]: relay.kp.pub };
const payloadOfSize = (n) => { const b = Buffer.alloc(n); for (let i = 0; i < n; i++) b[i] = (i * 37) & 0xff; return b; };
const mkBundle = (payload, seq = 7) => encodeBundle({
  primary: { crcType: CRC32C, dest: "ipn:2.1", source: "ipn:5.1", created: [812345678901, seq], lifetime: 86400000 },
  blocks: [{ type: BLOCK.PAYLOAD, number: 1, crcType: CRC32C, data: payload }],
});
const sha = (b) => createHash("sha256").update(b).digest();

const R = { label: LABEL, when: new Date().toISOString(), node: process.version, cpu: os.cpus()[0]?.model?.trim(), threads: os.cpus().length, arch: os.arch(), platform: os.platform(), maxLeaves: MAX_LEAVES };

// ---------------------------------------------------------------------------------------
// 1. Ed25519 / COSE_Sign1 primitives (node:crypto, which is OpenSSL)
const recPayload = encode(new Map([[1, "ipn:5.0"], [2, relay.eid], [3, [ "ipn:5.1", [812345678901, 7]]], [4, bstr(Buffer.alloc(32, 9))], [5, 812345678901], [6, 812345678950]]));
const cose = decode(encode(sign1(relay.kp.priv, recPayload))); // as a verifier sees it, off the wire
if (!verify1(cose, relay.kp.pub).ok) throw new Error("COSE_Sign1 did not verify");
R.cose = {
  receiptPayloadBytes: recPayload.length,
  coseSign1Bytes: encode(cose).length,
  sign: time(() => sign1(relay.kp.priv, recPayload)),
  verify: time(() => verify1(cose, relay.kp.pub)),
};

// 2. SHA-256 throughput (node:crypto), the cost of binding a receipt to the payload bytes
R.sha = {};
for (const s of SIZES) { const b = payloadOfSize(s); const t = time(() => sha(b)); R.sha[s] = { ...t, MBps: (t.perSec * s) / 1e6 }; }

// 3. Per-bundle version 2 receipts: real bundles, real block 224
R.perBundle = {};
for (const s of SIZES) {
  const b0 = mkBundle(payloadOfSize(s));
  const b1 = stampBundleV2(b0, relay, { prevHop: "ipn:5.0", receivedAt: 1, forwardedAt: 2 });
  const relay2 = { kp: genKeypair(), eid: "ipn:30.0" };
  const b2 = stampBundleV2(b1, relay2, { prevHop: relay.eid, receivedAt: 3, forwardedAt: 4 });
  const ok = verifyBundleV2(b1, { keys, origin: "ipn:5.0", lastNode: relay.eid });
  if (!ok.ok) throw new Error("receipt did not verify: " + JSON.stringify(ok));
  R.perBundle[s] = {
    bundleBytes: b0.length,
    firstReceiptBytes: b1.length - b0.length,       // block 224 header + CRC + one receipt
    nextReceiptBytes: b2.length - b1.length,         // each further custodian
    stamp: time(() => stampBundleV2(b0, relay, { prevHop: "ipn:5.0", receivedAt: 1, forwardedAt: 2 })),
    verify: time(() => verifyBundleV2(b1, { keys, origin: "ipn:5.0", lastNode: relay.eid })),
    decode: time(() => decodeBundle(b0)),
  };
}

// 4. Batched receipts. Two leaf rules:
//    content-bound:  leaf = leafHash(CBOR [bundle identity, SHA-256(payload)])  (hashes every payload byte)
//    identity-bound: leaf = leafHash(CBOR [bundle identity])                     (custody of the bundle id only)
// The batch receipt is a COSE_Sign1 over a CBOR map with the custody-batch/1 fields. Its
// carriage is not specified in draft -01 (section 8, Batching), so this encoding is the
// benchmark's, built from the repository's cbor.mjs and cose.mjs.
const idOf = (seq) => bundleIdentity(decodeBundle(mkBundle(Buffer.alloc(1), seq)));
const sampleId = idOf(7), samplePh = Buffer.alloc(32, 9);
R.batch = {
  leafContent: time(() => leafHash(encode([sampleId, bstr(samplePh)]))),
  leafIdentity: time(() => leafHash(encode([sampleId]))),
  closes: [],
};
const batchFields = (n, root) => encode(new Map([[1, "ipn:5.0"], [2, relay.eid], [5, 812345678901], [6, 812345738901], [8, n], [9, bstr(Buffer.from(root, "hex"))], [10, "contact-0001"]]));
R.batch.receiptBytes = encode(sign1(relay.kp.priv, batchFields(1_000_000, "ab".repeat(32)))).length;
// custody-batch/1 (canonical JSON, agent/lib/batch.mjs) for comparison
{
  const ids = Array.from({ length: 1000 }, (_, i) => "0x" + sha(Buffer.from(String(i))).toString("hex"));
  const b = batchReceipt(relay.kp, { prevHop: "ipn:5.0", thisHop: relay.eid, contactId: "contact-0001", from: 812345678901, to: 812345738901, bundleIds: ids });
  R.batch.jsonReceiptBytes = Buffer.byteLength(JSON.stringify(b.receipt));
}
// Close a batch of N leaves: build the tree (agent/lib/merkle.mjs) and sign once.
const leafPool = [];
for (let n = 1000; n <= MAX_LEAVES; n *= 10) {
  while (leafPool.length < n) leafPool.push(leafHash(encode([[ "ipn:5.1", [812345678901, leafPool.length]], bstr(samplePh)])));
  const leaves = leafPool.slice(0, n);
  let tree;
  const t = time(() => { tree = buildTree(leaves); sign1(relay.kp.priv, batchFields(n, tree.root)); }, MIN_MS, 1);
  const p = proof(tree, n >> 1);
  const pv = time(() => verifyProof(leaves[n >> 1], p, n >> 1, tree.root));
  R.batch.closes.push({ n, closeUs: t.us, perLeafUs: t.us / n, proofBytes: p.length * 32, proofVerifyUs: pv.us });
}
const biggest = R.batch.closes[R.batch.closes.length - 1];

// Streaming builder: the same tree and root as agent/lib/merkle.mjs (leaf 0x00, node 0x01,
// odd last node paired with itself), but each leaf is folded in as the bundle is taken into
// custody, so closing the batch costs log2(N) hashes plus one signature. Benchmark code, not
// yet in agent/lib; its root is checked against buildTree below.
class StreamTree {
  constructor() { this.pending = []; this.n = 0; }
  static node(l, r) { return createHash("sha256").update(NODE).update(l).update(r).digest(); }
  add(leaf) { // leaf: 32-byte Buffer
    let h = leaf, l = 0;
    while (this.pending[l]) { h = StreamTree.node(this.pending[l], h); this.pending[l] = null; l++; }
    this.pending[l] = h; this.n++;
  }
  root() {
    let carry = null;
    for (let l = 0; l < this.pending.length; l++) {
      const p = this.pending[l];
      const above = this.pending.slice(l + 1).some(Boolean);
      if (!above && (p ? !carry : carry)) return p ?? carry; // the only node left at the top layer
      if (p && carry) carry = StreamTree.node(p, carry);
      else if (p) carry = StreamTree.node(p, p);
      else if (carry) carry = StreamTree.node(carry, carry);
    }
    return carry;
  }
}
const NODE = Buffer.from([0x01]), LEAF = Buffer.from([0x00]);
const leafBuf = (bytes) => createHash("sha256").update(LEAF).update(bytes).digest();
while (leafPool.length < 4097) leafPool.push(leafHash(encode([["ipn:5.1", [812345678901, leafPool.length]], bstr(samplePh)])));
for (const n of [1, 2, 3, 5, 7, 1000, 1023, 4097]) { // same root as the reference tree
  const st = new StreamTree();
  for (let i = 0; i < n; i++) st.add(Buffer.from(leafPool[i], "hex"));
  if (st.root().toString("hex") !== buildTree(leafPool.slice(0, n)).root) throw new Error(`stream tree root differs at n=${n}`);
}
R.batch.stream = [];
for (let n = 1000; n <= MAX_LEAVES; n *= 10) {
  const leaves = leafPool.slice(0, n).map((h) => Buffer.from(h, "hex"));
  let st;
  const add = time(() => { st = new StreamTree(); for (const x of leaves) st.add(x); }, MIN_MS, 1);
  const close = time(() => sign1(relay.kp.priv, batchFields(n, st.root().toString("hex"))));
  R.batch.stream.push({ n, perLeafUs: add.us / n, closeUs: close.us });
}
R.batch.leafContentBuf = time(() => leafBuf(encode([sampleId, bstr(samplePh)])));
R.batch.leafIdentityBuf = time(() => leafBuf(encode([sampleId])));
const streamBig = R.batch.stream[R.batch.stream.length - 1];
R.batch.verifyReceipt = R.cose.verify; // one COSE_Sign1 verify per batch

// ---------------------------------------------------------------------------------------
// Derived tables (arithmetic on the measurements above)
const shaUsPerByte = (s) => R.sha[s].us / s;
const T = { bytesPerGB: [], cpu: [], latency: [] };
for (const s of SIZES) {
  const pb = R.perBundle[s], bundlesPerGB = GB / s;
  const row = { size: s, bundlesPerGB, perBundleFirst: bundlesPerGB * pb.firstReceiptBytes, perBundleNext: bundlesPerGB * pb.nextReceiptBytes, batch: {} };
  for (const rate of RATES) for (const w of WINDOWS) {
    const batchesPerGB = GB / ((rate / 8) * w);
    row.batch[`${rate}/${w}`] = batchesPerGB * R.batch.receiptBytes;
  }
  T.bytesPerGB.push(row);
}
for (const rate of RATES) for (const s of SIZES) {
  const bps = rate / 8 / s; // bundles per second
  const pb = R.perBundle[s];
  const cryptoOnlyUs = R.sha[s].us + R.cose.sign.us;
  const contentUs = shaUsPerByte(s) * s + R.batch.leafContentBuf.us + streamBig.perLeafUs; // streaming tree
  const identityUs = R.batch.leafIdentityBuf.us + streamBig.perLeafUs;
  T.cpu.push({
    rate, size: s, bundlesPerSec: bps,
    perBundleStampPct: bps * pb.stamp.us / 1e4,      // % of one core: (bundles/s * us) / 1e6 * 100
    perBundleCryptoPct: bps * cryptoOnlyUs / 1e4,
    perBundleVerifyPct: bps * pb.verify.us / 1e4,    // a verifier checking every receipt of one custodian
    batchContentPct: bps * contentUs / 1e4 + R.cose.sign.us / 1e4, // window 1 s: one signature per second
    batchIdentityPct: bps * identityUs / 1e4 + R.cose.sign.us / 1e4,
  });
}
for (const rate of RATES) for (const s of SIZES) for (const w of WINDOWS) {
  const n = (rate / 8 / s) * w;
  const ref = R.batch.closes.find((c) => c.n >= n) ?? biggest; // per-leaf close cost measured at the nearest batch size at or above n
  T.latency.push({
    rate, size: s, window: w, leaves: n,
    perBundleOnPathUs: R.perBundle[s].stamp.us + (R.perBundle[s].firstReceiptBytes * 8 / rate) * 1e6,
    batchCloseUs: n * ref.perLeafUs,
    streamCloseUs: (R.batch.stream.find((c) => c.n >= n) ?? streamBig).closeUs,
    closeExtrapolated: n > biggest.n,
    batchProofBytes: Math.ceil(Math.log2(Math.max(2, n))) * 32,
  });
}

// ---------------------------------------------------------------------------------------
// Report (markdown)
const out = [];
const p = (s = "") => out.push(s);
p(`### Run: ${LABEL}`);
p();
p(`${R.when}, ${R.cpu}, ${R.threads} threads, Node ${R.node}, ${R.platform} ${R.arch}, single thread, largest batch measured ${fmt(biggest.n)} leaves.`);
p();
p("**Primitives (node:crypto)**");
p();
p("| Operation | Per second | Each |");
p("|---|---|---|");
p(`| Ed25519 COSE_Sign1 sign (receipt payload ${R.cose.receiptPayloadBytes} B) | ${fmt(R.cose.sign.perSec)} | ${dur(R.cose.sign.us)} |`);
p(`| Ed25519 COSE_Sign1 verify (includes SPKI key import) | ${fmt(R.cose.verify.perSec)} | ${dur(R.cose.verify.us)} |`);
for (const s of SIZES) p(`| SHA-256 of a ${SIZE_NAME[s]} payload | ${fmt(R.sha[s].perSec)} (${fmt(R.sha[s].MBps)} MB/s) | ${dur(R.sha[s].us)} |`);
p();
p("**Per-bundle receipts in block 224 (stampBundleV2 / verifyBundleV2 on real bundle bytes)**");
p();
p("| Bundle payload | Bundle bytes | Block 224 + first receipt | Each further receipt | Stamp (decode, hash, sign, re-encode) | Verify one receipt | Decode only |");
p("|---|---|---|---|---|---|---|");
for (const s of SIZES) { const b = R.perBundle[s]; p(`| ${SIZE_NAME[s]} | ${fmt(b.bundleBytes)} | ${b.firstReceiptBytes} B | ${b.nextReceiptBytes} B | ${dur(b.stamp.us)} | ${dur(b.verify.us)} | ${dur(b.decode.us)} |`); }
p();
p("**Batched receipts**");
p();
p(`Batch receipt (COSE_Sign1, CBOR): ${R.batch.receiptBytes} B. The same fields as custody-batch/1 canonical JSON: ${R.batch.jsonReceiptBytes} B.`);
p(`Leaf per bundle (Buffer path): content-bound ${dur(R.batch.leafContentBuf.us)} plus the payload SHA-256 above; identity-bound ${dur(R.batch.leafIdentityBuf.us)}. Reference hex path (agent/lib/merkle.mjs leafHash): ${dur(R.batch.leafContent.us)}.`);
p();
p("| Bundles in batch | Reference: build tree at close + sign | Reference per leaf | Streaming: fold per leaf | Streaming: close (root + sign) | Inclusion proof | Proof check |");
p("|---|---|---|---|---|---|---|");
R.batch.closes.forEach((c, i) => { const st = R.batch.stream[i]; p(`| ${fmt(c.n)} | ${dur(c.closeUs)} | ${dur(c.perLeafUs)} | ${dur(st.perLeafUs)} | ${dur(st.closeUs)} | ${c.proofBytes} B | ${dur(c.proofVerifyUs)} |`); });
p();
p("**Receipt bytes per GB of payload (one custodian hop)**");
p();
p("| Bundle size | Bundles per GB | Per-bundle receipts | Batch, 1 s window, 100 Mbps | 1 Gbps | 10 Gbps | 100 Gbps | Batch, 60 s window, 100 Mbps | 100 Gbps |");
p("|---|---|---|---|---|---|---|---|---|");
for (const r of T.bytesPerGB) {
  const b = (rate, w) => `${sig(r.batch[`${rate}/${w}`])} B`;
  p(`| ${SIZE_NAME[r.size]} | ${fmt(r.bundlesPerGB)} | ${fmt(r.perBundleFirst)} B (${sig(r.perBundleFirst / GB * 100)}%) | ${b(1e8, 1)} | ${b(1e9, 1)} | ${b(1e10, 1)} | ${b(1e11, 1)} | ${b(1e8, 60)} | ${b(1e11, 60)} |`);
}
p();
p("**CPU to keep up with the link, percent of one core (over 100% means more than one core)**");
p();
p("| Link | Bundle size | Bundles/s | Per-bundle: stamp | Per-bundle: hash + sign only | Per-bundle: verifier | Batch, content-bound | Batch, identity-bound |");
p("|---|---|---|---|---|---|---|---|");
for (const c of T.cpu) p(`| ${RATE_NAME[c.rate]} | ${SIZE_NAME[c.size]} | ${fmt(c.bundlesPerSec)} | ${sig(c.perBundleStampPct)}% | ${sig(c.perBundleCryptoPct)}% | ${sig(c.perBundleVerifyPct)}% | ${sig(c.batchContentPct)}% | ${sig(c.batchIdentityPct)}% |`);
p();
p("**Latency**");
p();
p("| Link | Bundle size | Per-bundle: added on the forwarding path, per bundle per hop | Batch: on the forwarding path | Batch close, streaming, 60 s window | Batch close, reference rebuild, 1 s window | Batch close, reference rebuild, 60 s window |");
p("|---|---|---|---|---|---|---|");
for (const rate of RATES) for (const s of SIZES) {
  const l1 = T.latency.find((l) => l.rate === rate && l.size === s && l.window === 1);
  const l60 = T.latency.find((l) => l.rate === rate && l.size === s && l.window === 60);
  const cl = (l) => `${dur(l.batchCloseUs)} (${fmt(l.leaves)} leaves${l.closeExtrapolated ? ", extrapolated" : ""})`;
  p(`| ${RATE_NAME[rate]} | ${SIZE_NAME[s]} | ${dur(l1.perBundleOnPathUs)} | 0 | ${dur(l60.streamCloseUs)} | ${cl(l1)} | ${cl(l60)} |`);
}
console.log(out.join("\n"));
if (JSON_OUT) writeFileSync(JSON_OUT, JSON.stringify({ ...R, derived: T }, null, 1));
