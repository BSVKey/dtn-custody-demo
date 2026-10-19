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
//
// Optional per-bundle times (leafTimes): a contact held open for a long time, as on
// persistent optical links, says which bundles passed but not in what order. When the node
// passes `times` (one per bundle id, the time it took custody), each leaf commits to
// "id@time", the record is signed with leafTimes: true, and every inclusion proof carries
// that time. A verifier can then order any route exactly, including one that loops back
// through the same node, instead of guessing from overlapping windows. Batches without
// leafTimes are unchanged.
import { leafHash, buildTree, proof, verifyProof } from "./merkle.mjs";
import { signRecord } from "./receipt.mjs";

export const BATCH_KIND = "custody-batch/1";

// Build and sign a batch. Returns { receipt, leaves, tree } where `leaves` is the sorted id
// list the node keeps (or downlinks) so inclusion proofs can be produced later.
const leafBytes = (id, t) => Buffer.from(t === undefined ? id : `${id}@${t}`, "utf8");

export function batchReceipt(kp, { prevHop, thisHop, contactId, from, to, bundleIds, times }) {
  if (!(to >= from)) throw new Error("batchReceipt: window must end at or after it starts");
  if (times === undefined) {
    const leaves = [...new Set(bundleIds)].sort();
    if (leaves.length === 0) throw new Error("batchReceipt: no bundles");
    const tree = buildTree(leaves.map((id) => leafHash(leafBytes(id))));
    const receipt = signRecord(kp, { kind: BATCH_KIND, prevHop, thisHop, contactId, from, to, count: leaves.length, root: tree.root });
    return { receipt, leaves, tree };
  }
  if (!Array.isArray(times) || times.length !== bundleIds.length) throw new Error("batchReceipt: one time per bundle id");
  const at = new Map();
  bundleIds.forEach((id, i) => {
    const t = times[i];
    if (!Number.isSafeInteger(t) || t < from || t > to) throw new Error("batchReceipt: each time must be an integer inside the window");
    if (at.has(id)) throw new Error("batchReceipt: a bundle may appear once per batch; start a new batch for a second pass");
    at.set(id, t);
  });
  const leaves = [...at.keys()].sort();
  if (leaves.length === 0) throw new Error("batchReceipt: no bundles");
  const leafTimes = leaves.map((id) => at.get(id));
  const tree = buildTree(leaves.map((id, i) => leafHash(leafBytes(id, leafTimes[i]))));
  const receipt = signRecord(kp, { kind: BATCH_KIND, prevHop, thisHop, contactId, from, to, count: leaves.length, root: tree.root, leafTimes: true });
  return { receipt, leaves, leafTimes, tree };
}

// Inclusion proof for one bundle in a batch the caller holds (receipt + leaves + tree).
export function batchProof(batch, bundleId) {
  const index = batch.leaves.indexOf(bundleId);
  if (index < 0) return null;
  const p = { index, branch: proof(batch.tree, index) };
  if (batch.leafTimes) p.t = batch.leafTimes[index];
  return p;
}

// Is `bundleId` covered by the (already signature-checked) batch receipt?
export function inBatch(receipt, bundleId, p) {
  if (!p || !Number.isSafeInteger(p.index) || p.index < 0 || p.index >= receipt.count) return false;
  if (receipt.leafTimes) {
    if (!Number.isSafeInteger(p.t) || p.t < receipt.from || p.t > receipt.to) return false;
    return verifyProof(leafHash(leafBytes(bundleId, p.t)), p.branch, p.index, receipt.root);
  }
  return verifyProof(leafHash(leafBytes(bundleId)), p.branch, p.index, receipt.root);
}
