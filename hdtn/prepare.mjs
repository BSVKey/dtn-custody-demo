// Sender side of the HDTN interop run: chunk + Merkle-commit a payload, sign the manifest,
// sign a custody handoff receipt per chunk at the sender node (ipn:1.1), and write each
// as a file for HDTN's BpSendFile. Keys are pinned for the verifier via /tmp/pins.json
// (in a real deployment the verifier holds these out of band).
import { mkdirSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { genKeypair } from "../agent/lib/keys.mjs";
import { prepare } from "../agent/source.mjs";
import { custodyReceipt } from "../agent/lib/receipt.mjs";

const OUT = process.env.SEND_DIR || "/tmp/send";
mkdirSync(OUT, { recursive: true });
const source = genKeypair();
const sender = genKeypair();
const payload = Buffer.from("DTN CUSTODY over NASA HDTN: chunked, Merkle-committed, custody-signed, routed by a compiled contact plan. ".repeat(12), "utf8");
const { manifest, bundles } = prepare(source, payload, { payloadId: "0xhdtn-interop-001", chunkSize: 64 });
writeFileSync(`${OUT}/manifest.json`, JSON.stringify(manifest));
const now = Date.now();
for (const b of bundles) {
  const handoff = custodyReceipt(sender, { payloadId: b.payloadId, bundleId: b.bundleId, prevHop: "app:source", thisHop: "ipn:1.1", receivedAt: now, forwardedAt: now });
  writeFileSync(`${OUT}/chunk-${String(b.index).padStart(3, "0")}.json`, JSON.stringify({ bundle: b, custody: [handoff] }));
}
writeFileSync("/tmp/pins.json", JSON.stringify({ sourcePub: source.pub, senderPub: sender.pub, payloadSha256: createHash("sha256").update(payload).digest("hex"), chunks: bundles.length }));
console.log(`[hdtn] prepared manifest + ${bundles.length} chunk files (${payload.length} bytes) in ${OUT}`);
