// Destination (Earth ground station) role: verify each chunk against the manifest
// root as it arrives OUT OF ORDER, reassemble when complete, verify the custody
// chain, and produce a delivery receipt bound to the settlement the verifier paid.
import { leafHash, verifyProof } from "./lib/merkle.mjs";
import { verifyRecord, verifyCustodyChain, deliveryReceipt, bindDelivery } from "./lib/receipt.mjs";

// Authorship is pinned the same way delivery is bound: the expected source key
// (the manifest signer) MUST come from the verifier's own context, never from the
// manifest, which carries its own signerPub. A missing sourcePub refuses rather
// than skips, so a payload signed by a key the destination has never seen can't
// verify end to end just because the relays forwarded it.
function refuse(reason, detail) {
  const e = new Error(detail ? `${reason}: ${detail}` : reason);
  e.reason = reason;
  return e;
}

export function makeDest(kp, manifest, pinnedHops, { sourcePub } = {}) {
  if (!sourcePub) throw refuse("unpinned", "verifier must supply the expected source (manifest signer) key");
  const mv = verifyRecord(manifest);
  if (!mv.ok) throw refuse(mv.reason, "manifest does not verify");
  if (String(mv.signer).toLowerCase() !== String(sourcePub).toLowerCase()) throw refuse("signer_not_pinned_source_key");
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
    // Custody receipts can arrive interleaved/out of order over a real transport, so
    // order them by their position in the pinned hop list before checking the chain.
    verifyChain(bundleId) {
      const order = new Map(pinnedHops.map((h, i) => [h.eid, i]));
      const sorted = [...(custody.get(bundleId) || [])].sort(
        (a, b) => (order.get(a.thisHop) ?? 99) - (order.get(b.thisHop) ?? 99),
      );
      return verifyCustodyChain(sorted, { bundleId, hops: pinnedHops });
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
