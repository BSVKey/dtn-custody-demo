// Emit a deterministic BPv7 bundle carrying a two-hop Custody Receipt Block, as hex,
// for cross-checking against an independent BPv7 implementation (pyd3tn-check.py).
// Usage: node vector.mjs            -> prints hex
//        node vector.mjs <hex>      -> decodes a bundle made elsewhere and prints JSON
import { encode } from "../cbor.mjs";
import { encodeBundle, decodeBundle, encodeEid, BLOCK, CRC16, CRC32C } from "../bundle.mjs";
import { withCustody, readCustody, CUSTODY_BLOCK_TYPE } from "../custody-block.mjs";
import { signRecord } from "../../../agent/lib/receipt.mjs";
import { createPrivateKey, createPublicKey } from "node:crypto";

// Fixed public test seeds (the same ones as spec/test-vectors.json); never for real use.
function testKey(seedHex) {
  const priv = createPrivateKey({ key: Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), Buffer.from(seedHex, "hex")]), format: "der", type: "pkcs8" });
  return { priv, pub: createPublicKey(priv).export({ type: "spki", format: "der" }).toString("base64") };
}

const arg = process.argv[2];
if (arg) {
  const b = decodeBundle(Buffer.from(arg, "hex"));
  const out = { primary: b.primary, blocks: b.blocks.map((x) => ({ type: x.type, number: x.number, flags: x.flags, crcType: x.crcType, len: x.data.length })) };
  if (b.blocks.some((x) => x.type === CUSTODY_BLOCK_TYPE)) out.receipts = readCustody(b).length;
  console.log(JSON.stringify(out));
} else {
  const kps = [testKey("02".repeat(32)), testKey("04".repeat(32))];
  const body = { payloadId: "0xvector", index: 0, leafHex: "00".repeat(32), bytesB64: "aGVsbG8=", branch: [] };
  const recs = kps.map((kp, i) => signRecord(kp, { kind: "custody/1", payloadId: body.payloadId, bundleId: "0xb", prevHop: i ? "dtn://relaya/" : "dtn://source/", thisHop: i ? "dtn://relayb/" : "dtn://relaya/", receivedAt: 100 + i, forwardedAt: 150 + i }));
  const bundle = withCustody({
    primary: { flags: 0, crcType: CRC16, dest: "dtn://dest/payload", source: "dtn://source/payload", reportTo: "dtn:none", created: [776000000000, 7], lifetime: 86400000 },
    blocks: [
      { type: BLOCK.PREVIOUS_NODE, number: 2, flags: 0, crcType: CRC16, data: encode(encodeEid("dtn://relayb/")) },
      { type: BLOCK.HOP_COUNT, number: 3, flags: 0, crcType: CRC32C, data: encode([16, 2]) },
      { type: BLOCK.PAYLOAD, number: 1, flags: 0, crcType: CRC32C, data: Buffer.from(JSON.stringify(body)) },
    ],
  }, recs);
  console.log(encodeBundle(bundle).toString("hex"));
}
