// Batched custody receipts: one signature per contact instead of one per bundle.
//
// At the end of a contact (or any window), a node signs a single `custody-batch/1` record
// naming the previous hop, itself, the window, the number of bundles it took custody of,
// and the Merkle root over their bundle ids. Any one bundle is proven by the batch record
// plus a short inclusion proof, so per-bundle custody survives while signatures and
// record bytes drop by the batch size.
//
// Leaves are the bundle ids, sorted and de-duplicated, hashed with the same
// domain-separated leaf rule as payload chunks (leafHash over the UTF-8 id), so the
// batch root is deterministic for a given set of bundles.
import { leafHash, buildTree, proof, verifyProof } from "./merkle.mjs";
import { signRecord } from "./receipt.mjs";

export const BATCH_KIND = "custody-batch/1";

// Build and sign a batch. Returns { receipt, leaves, tree } where `leaves` is the sorted id
// list the node keeps (or downlinks) so inclusion proofs can be produced later.
export function batchReceipt(kp, { prevHop, thisHop, contactId, from, to, bundleIds }) {
  const leaves = [...new Set(bundleIds)].sort();
  if (leaves.length === 0) throw new Error("batchReceipt: no bundles");
  if (!(to >= from)) throw new Error("batchReceipt: window must end at or after it starts");
  const tree = buildTree(leaves.map((id) => leafHash(Buffer.from(id, "utf8"))));
  const receipt = signRecord(kp, { kind: BATCH_KIND, prevHop, thisHop, contactId, from, to, count: leaves.length, root: tree.root });
  return { receipt, leaves, tree };
}

// Inclusion proof for one bundle in a batch the caller holds (receipt + leaves + tree).
export function batchProof(batch, bundleId) {
  const index = batch.leaves.indexOf(bundleId);
  if (index < 0) return null;
  return { index, branch: proof(batch.tree, index) };
}

// Is `bundleId` covered by the (already signature-checked) batch receipt?
export function inBatch(receipt, bundleId, p) {
  if (!p || !Number.isSafeInteger(p.index) || p.index < 0 || p.index >= receipt.count) return false;
  return verifyProof(leafHash(Buffer.from(bundleId, "utf8")), p.branch, p.index, receipt.root);
}
