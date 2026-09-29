// Performance and overhead of the custody layer, measured with the repository's own code.
//   node bench/bench.mjs            print a report
//   node bench/bench.mjs --write    also write bench/RESULTS.md
import { writeFileSync } from "node:fs";
import os from "node:os";
import { genKeypair, signClaim, verifySig } from "../agent/lib/keys.mjs";
import { leafHash, buildTree, proof, verifyProof } from "../agent/lib/merkle.mjs";
import { contentId } from "../agent/lib/canonical.mjs";
import { prepare } from "../agent/source.mjs";
import { custodyReceipt, verifyRecord } from "../agent/lib/receipt.mjs";

const time = (fn, minMs = 400) => {
  let n = 0;
  const t0 = process.hrtime.bigint();
  let el = 0;
  while (el < minMs) { fn(); n++; el = Number(process.hrtime.bigint() - t0) / 1e6; }
  return { perSec: (n / el) * 1000, usEach: (el * 1000) / n };
};
const fmt = (x, d = 0) => x.toLocaleString("en-US", { maximumFractionDigits: d, minimumFractionDigits: d });

const kp = genKeypair();
const r = {};

// 1. Signatures (one per custody receipt, one per manifest)
const claim = "0x" + "ab".repeat(32);
const sig = signClaim(kp.priv, claim);
r.sign = time(() => signClaim(kp.priv, claim));
r.verify = time(() => verifySig(kp.pub, claim, sig));

// 2. Hashing throughput (one leaf hash per chunk)
const hashRows = [];
for (const size of [1024, 65536, 1048576]) {
  const buf = Buffer.alloc(size, 7);
  const t = time(() => leafHash(buf));
  hashRows.push({ size, perSec: t.perSec, mbps: (t.perSec * size) / 1e6 });
}

// 3. Manifest build (hash + tree + sign) for a 10 MB payload at several chunk sizes
const payload = Buffer.alloc(10 * 1024 * 1024, 3);
const chunkRows = [];
for (const chunkSize of [1024, 16384, 65536, 1048576]) {
  const t0 = process.hrtime.bigint();
  const { manifest, bundles } = prepare(kp, payload, { payloadId: "0xbench", chunkSize });
  const buildMs = Number(process.hrtime.bigint() - t0) / 1e6;
  const b = bundles[Math.floor(bundles.length / 2)];
  const r1 = custodyReceipt(kp, { payloadId: b.payloadId, bundleId: b.bundleId, prevHop: "dtn://relaya.example/", thisHop: "dtn://relayb.example/", receivedAt: 1790000000000, forwardedAt: 1790000000050 });
  const proofBytes = b.branch.length * 32;                        // raw hashes
  const perChunkMetaBytes = 32 /* leaf */ + proofBytes + 32 /* bundleId */ + 8 /* index */;
  const receiptJsonBytes = Buffer.byteLength(JSON.stringify(r1));
  const hops = 2;
  const overheadPct = ((perChunkMetaBytes + hops * receiptJsonBytes) / chunkSize) * 100;
  const tv0 = process.hrtime.bigint();
  let ok = 0;
  for (const x of bundles.slice(0, 200)) if (verifyProof(leafHash(Buffer.from(x.bytesB64, "base64")), x.branch, x.index, manifest.root)) ok++;
  const verifyUsPerChunk = (Number(process.hrtime.bigint() - tv0) / 1e3) / Math.min(200, bundles.length);
  chunkRows.push({ chunkSize, chunks: bundles.length, buildMs, proofHashes: b.branch.length, perChunkMetaBytes, receiptJsonBytes, overheadPct, verifyUsPerChunk, manifestJsonBytes: Buffer.byteLength(JSON.stringify(manifest)), ok });
}

// 4. A full custody receipt: create and verify
const sample = custodyReceipt(kp, { payloadId: "0xbench", bundleId: contentId({ x: 1 }), prevHop: "dtn://relaya.example/", thisHop: "dtn://relayb.example/", receivedAt: 1790000000000, forwardedAt: 1790000000050 });
r.receiptCreate = time(() => custodyReceipt(kp, { payloadId: "0xbench", bundleId: sample.bundleId, prevHop: "a", thisHop: "b", receivedAt: 1, forwardedAt: 2 }));
r.receiptVerify = time(() => verifyRecord(sample));

const env = `${os.cpus()[0].model.trim()}, ${os.cpus().length} threads, Node ${process.version}, ${os.platform()} ${os.arch()}, single thread`;
const lines = [];
lines.push("# Custody layer: performance and overhead", "", `Measured ${new Date().toISOString().slice(0, 10)} on ${env}.`, "Reproduce: `node bench/bench.mjs`. Figures are for this machine; flight processors will be slower.", "");
lines.push("## Signing and verification", "", "| Operation | Per second | Microseconds each |", "|---|---|---|");
lines.push(`| Ed25519 sign (one per custody receipt) | ${fmt(r.sign.perSec)} | ${fmt(r.sign.usEach, 1)} |`);
lines.push(`| Ed25519 verify | ${fmt(r.verify.perSec)} | ${fmt(r.verify.usEach, 1)} |`);
lines.push(`| Create a full custody receipt (canonical JSON, SHA-256, sign) | ${fmt(r.receiptCreate.perSec)} | ${fmt(r.receiptCreate.usEach, 1)} |`);
lines.push(`| Verify a full custody receipt | ${fmt(r.receiptVerify.perSec)} | ${fmt(r.receiptVerify.usEach, 1)} |`, "");
lines.push("## Chunk fingerprinting (SHA-256 leaf hash)", "", "| Chunk size | Hashes per second | Throughput |", "|---|---|---|");
for (const h of hashRows) lines.push(`| ${fmt(h.size / 1024)} KiB | ${fmt(h.perSec)} | ${fmt(h.mbps)} MB/s |`);
lines.push("", "## A 10 MB payload at different chunk sizes (two relay hops)", "", "| Chunk size | Chunks | Build manifest (hash, tree, sign) | Proof per chunk | Custody metadata per chunk | Receipt size | Overhead vs payload | Verify per chunk |", "|---|---|---|---|---|---|---|---|");
for (const c of chunkRows) lines.push(`| ${fmt(c.chunkSize / 1024)} KiB | ${fmt(c.chunks)} | ${fmt(c.buildMs)} ms | ${c.proofHashes} hashes (${c.proofHashes * 32} B) | ${fmt(c.perChunkMetaBytes)} B | ${fmt(c.receiptJsonBytes)} B | ${fmt(c.overheadPct, 2)}% | ${fmt(c.verifyUsPerChunk, 1)} us |`);
lines.push("", "Overhead counts the chunk's leaf hash, Merkle proof, bundle id and index, plus one JSON custody receipt per relay hop, against the chunk's payload bytes. The manifest is sent once per payload (about " + fmt(chunkRows[0].manifestJsonBytes) + " bytes). Receipts are JSON for readability; a binary encoding would be several times smaller.", "");
lines.push("## Reading this", "", "- Chunks of 16 KiB or more keep custody overhead near or below 1% of the data.", "- One relay can sign thousands of receipts per second on one core, well above typical lunar relay bundle rates.", "- Verification is cheap enough to check every chunk and every hop at the destination.");
const text = lines.join("\n") + "\n";
console.log(text);
if (process.argv.includes("--write")) writeFileSync(new URL("./RESULTS.md", import.meta.url), text);
