// Destination (Earth ground station) role: verify each chunk against the manifest
// root as it arrives OUT OF ORDER, reassemble when complete, verify the custody
// chain, and produce a delivery receipt bound to the settlement the verifier paid.
import { leafHash, verifyProof } from "./lib/merkle.mjs";
import { verifyRecord, verifyCustodyChain, deliveryReceipt, bindDelivery } from "./lib/receipt.mjs";

export function makeDest(kp, manifest, pinnedHops) {
  const mv = verifyRecord(manifest);
  if (!mv.ok) throw new Error(`manifest does not verify: ${mv.reason}`);
  const root = manifest.root;
  const chunks = new Map(); // index -> Buffer (only after passing the Merkle check)
  const custody = new Map(); // bundleId -> [receipts]

  return {
    // Accept a bundle. Verifies leaf == sha256 of the bytes AND the branch to the
    // root. A tampered chunk (bad bytes or bad branch) is rejected, not stored.
    receiveBundle(bundle) {
      const bytes = Buffer.from(bundle.bytesB64, "base64");
      if (leafHash(bytes) !== bundle.leafHex) return { ok: false, reason: "leaf_hash_mismatch" };
      if (!verifyProof(bundle.leafHex, bundle.branch, bundle.index, root)) {
        return { ok: false, reason: "merkle_branch_invalid" };
      }
      chunks.set(bundle.index, bytes);
      return { ok: true };
    },

    recordCustody(bundleId, receipt) {
      if (!custody.has(bundleId)) custody.set(bundleId, []);
      custody.get(bundleId).push(receipt);
    },

    isComplete() {
      return chunks.size === manifest.chunkCount;
    },

    // Reassemble the payload in index order once every chunk has passed the checks.
    reassemble() {
      if (!this.isComplete()) throw new Error("reassemble before complete");
      const parts = [];
      for (let i = 0; i < manifest.chunkCount; i++) parts.push(chunks.get(i));
      return Buffer.concat(parts);
    },

    // Verify the custody chain recorded for a bundle against the pinned hop keys.
    verifyChain(bundleId) {
      return verifyCustodyChain(custody.get(bundleId) || [], { bundleId, hops: pinnedHops });
    },

    // Produce a delivery receipt and bind it to the caller's own settlement. The
    // expected settlementRef MUST come from the verifier's context (readSettlement),
    // never from the receipt.
    settle(kp2, { payloadId, root: r, rail, network, settlementRef, payTo, amountAtomic }, expected) {
      const rec = deliveryReceipt(kp2, { payloadId, root: r, rail, network, settlementRef, payTo, amountAtomic });
      return { receipt: rec, bind: bindDelivery(rec, expected) };
    },

    _chunks: chunks,
    _custody: custody,
  };
}
