// Source (rover) role: chunk a payload, build a Merkle tree, and emit one bundle per
// chunk (leaf bytes + its Merkle branch) plus a signed manifest carrying the root.
import { leafHash, buildTree, proof } from "./lib/merkle.mjs";
import { contentId } from "./lib/canonical.mjs";
import { buildManifest, signRecord } from "./lib/receipt.mjs";

export function chunk(bytes, chunkSize = 1024) {
  const buf = Buffer.from(bytes);
  const out = [];
  for (let i = 0; i < buf.length; i += chunkSize) out.push(buf.subarray(i, i + chunkSize));
  if (out.length === 0) out.push(Buffer.alloc(0));
  return out;
}

// Prepare a payload for transmission. Returns { manifest, bundles }.
//   manifest: signed { kind, payloadId, chunkCount, root, meta }
//   bundles:  [{ payloadId, index, bytesB64, leafHex, branch, bundleId }]
export function prepare(kp, payloadBytes, { payloadId, meta = {}, chunkSize = 1024 } = {}) {
  const id = payloadId || "0x" + contentId({ p: Buffer.from(payloadBytes).toString("base64") }).slice(2, 18);
  const chunks = chunk(payloadBytes, chunkSize);
  const leaves = chunks.map((c) => leafHash(c));
  const tree = buildTree(leaves);
  const manifest = signRecord(kp, buildManifest({
    payloadId: id, chunkCount: chunks.length, root: tree.root,
    meta: { chunkSize, ...meta },
  }));
  const bundles = chunks.map((c, index) => {
    const leafHex = leaves[index];
    const body = { payloadId: id, index, leafHex };
    return {
      ...body,
      bytesB64: Buffer.from(c).toString("base64"),
      branch: proof(tree, index),
      bundleId: contentId(body),
    };
  });
  return { manifest, bundles };
}
