// Batched receipts and verification over routes that were not listed in advance.
import test from "node:test";
import assert from "node:assert/strict";
import { genKeypair } from "../agent/lib/keys.mjs";
import { signRecord, custodyReceipt } from "../agent/lib/receipt.mjs";
import { batchReceipt, batchProof, inBatch, BATCH_KIND } from "../agent/lib/batch.mjs";
import { verifyPath, pinnedDirectory, assemblePath } from "../agent/lib/path.mjs";

const node = (n) => `ipn:${n}.0`;
const keys = Object.fromEntries([1, 2, 3, 4, 5, 9].map((n) => [n, genKeypair()]));
const dir = pinnedDirectory(Object.fromEntries(Object.entries(keys).map(([n, k]) => [node(n), k.pub])));
const bundles = ["0xb1", "0xb2", "0xb3"];

// Route for b1 and b2: 1 -> 2 -> 3 -> 9 (ground). b3 is rerouted: 1 -> 2 -> 4 -> 9.
const hop = (from, to, ids, t) => batchReceipt(keys[to], { prevHop: node(from), thisHop: node(to), contactId: `${from}-${to}-${t}`, from: t, to: t + 10, bundleIds: ids });
const H12 = hop(1, 2, bundles, 100), H23 = hop(2, 3, ["0xb1", "0xb2"], 200), H24 = hop(2, 4, ["0xb3"], 210);
const H39 = hop(3, 9, ["0xb1", "0xb2"], 300), H49 = hop(4, 9, ["0xb3"], 320);
const link = (b, id) => ({ receipt: b.receipt, proof: batchProof(b, id) });
const opts = (bundleId) => ({ bundleId, source: node(1), destination: node(9), authorize: dir });

test("batch: one signature covers many bundles, each provable, others refused", () => {
  assert.equal(H12.receipt.kind, BATCH_KIND);
  assert.equal(H12.receipt.count, 3);
  for (const id of bundles) assert.equal(inBatch(H12.receipt, id, batchProof(H12, id)), true);
  assert.equal(batchProof(H23, "0xb3"), null);
  assert.equal(inBatch(H23.receipt, "0xb3", batchProof(H12, "0xb3")), false);
  assert.throws(() => batchReceipt(keys[2], { prevHop: "a", thisHop: "b", contactId: "c", from: 1, to: 2, bundleIds: [] }), /no bundles/);
});

test("path: two different routes verify, with batch and per-bundle hops mixed", () => {
  assert.deepEqual(verifyPath([link(H12, "0xb1"), link(H23, "0xb1"), link(H39, "0xb1")], opts("0xb1")), { ok: true, hops: 3, revisits: 0 });
  const perBundle = { receipt: custodyReceipt(keys[4], { payloadId: "p", bundleId: "0xb3", prevHop: node(2), thisHop: node(4), receivedAt: 210, forwardedAt: 215 }) };
  assert.deepEqual(verifyPath([link(H12, "0xb3"), perBundle, link(H49, "0xb3")], opts("0xb3")), { ok: true, hops: 3, revisits: 0 });
});

test("path: assembled from an unordered pool of hop records", () => {
  const pool = [link(H39, "0xb2"), link(H12, "0xb2"), link(H23, "0xb2")];
  assert.equal(verifyPath(assemblePath(pool, node(1)), opts("0xb2")).ok, true);
});

test("path: every tampering case is refused with its reason", () => {
  const good = [link(H12, "0xb1"), link(H23, "0xb1"), link(H39, "0xb1")];
  const rogue = genKeypair();
  const forged = batchReceipt(rogue, { prevHop: node(2), thisHop: node(3), contactId: "x", from: 200, to: 210, bundleIds: ["0xb1"] });
  assert.equal(verifyPath([good[0], link(forged, "0xb1"), good[2]], opts("0xb1")).reason, "signer_not_authorized");
  assert.equal(verifyPath([good[0], good[2]], opts("0xb1")).reason, "chain_break");
  assert.equal(verifyPath([good[0], { receipt: H23.receipt, proof: batchProof(H12, "0xb3") }, good[2]], opts("0xb3")).reason, "not_in_batch");
  assert.equal(verifyPath(good.slice(0, 2), opts("0xb1")).reason, "wrong_destination");
  assert.equal(verifyPath(good.slice(1), opts("0xb1")).reason, "wrong_source");
  const edited = structuredClone(good); edited[1].receipt.count = 9;
  assert.equal(verifyPath(edited, opts("0xb1")).reason, "claimId_mismatch");
  const late = hop(1, 2, bundles, 5000);
  assert.equal(verifyPath([link(late, "0xb1"), good[1], good[2]], opts("0xb1")).reason, "time_regression");
  const back = hop(3, 2, ["0xb1"], 250);
  assert.equal(verifyPath([good[0], good[1], link(back, "0xb1"), good[2]], opts("0xb1")).reason, "chain_break");
  assert.equal(verifyPath(good, { ...opts("0xb1"), maxHops: 2 }).reason, "too_many_hops");
  const stranger = signRecord(genKeypair(), { kind: "custody-batch/1", prevHop: node(2), thisHop: node(7), contactId: "y", from: 200, to: 210, count: 1, root: "00" });
  assert.equal(verifyPath([good[0], { receipt: stranger, proof: { index: 0, branch: [] } }], opts("0xb1")).reason, "not_in_batch");
});

test("path: a batch signature is verified once and reused across bundles", () => {
  const cache = new Map();
  for (const id of ["0xb1", "0xb2"]) assert.equal(verifyPath([link(H12, id), link(H23, id), link(H39, id)], { ...opts(id), cache }).ok, true);
  assert.equal(cache.size, 3);
});

test("path: a reroute back through a satellite already visited is accepted and counted", () => {
  const back = hop(3, 2, ["0xb1"], 250), out = hop(2, 9, ["0xb1"], 300);
  assert.deepEqual(verifyPath([link(H12, "0xb1"), link(H23, "0xb1"), link(back, "0xb1"), link(out, "0xb1")], opts("0xb1")), { ok: true, hops: 4, revisits: 1 });
});

test("leafTimes: a batch commits each bundle's time, and the proof carries it", () => {
  const b = batchReceipt(keys[2], { prevHop: node(1), thisHop: node(2), contactId: "c", from: 100, to: 900, bundleIds: ["0xb2", "0xb1"], times: [700, 150] });
  assert.equal(b.receipt.leafTimes, true);
  const p = batchProof(b, "0xb1");
  assert.equal(p.t, 150);
  assert.equal(inBatch(b.receipt, "0xb1", p), true);
  assert.equal(inBatch(b.receipt, "0xb1", { ...p, t: 151 }), false, "a changed time breaks the proof");
  assert.equal(inBatch(b.receipt, "0xb1", { ...p, t: undefined }), false, "a proof without its time is refused");
  assert.throws(() => batchReceipt(keys[2], { prevHop: node(1), thisHop: node(2), contactId: "c", from: 100, to: 200, bundleIds: ["0xb1"], times: [250] }), /inside the window/);
  assert.throws(() => batchReceipt(keys[2], { prevHop: node(1), thisHop: node(2), contactId: "c", from: 100, to: 200, bundleIds: ["0xb1", "0xb1"], times: [110, 120] }), /once per batch/);
});

test("leafTimes: a looping route with overlapping long contacts verifies in its true order", () => {
  // 1 -> 2 -> 3 -> 2 -> 4 -> 9. Every contact is open 0..1000, so the windows alone cannot
  // order the hops; the committed times can.
  const id = "0xloop";
  const h = (from, to, t, cid = `${from}-${to}`) => batchReceipt(keys[to], { prevHop: node(from), thisHop: node(to), contactId: cid, from: 0, to: 1000, bundleIds: [id], times: [t] });
  const recs = [h(1, 2, 100), h(2, 3, 200), h(3, 2, 300, "3-2"), h(2, 4, 400), h(4, 9, 500)];
  const app = batchReceipt(keys[1], { prevHop: "app:1", thisHop: node(1), contactId: "src", from: 0, to: 1000, bundleIds: [id], times: [50] });
  const entries = [app, ...recs].reverse().map((b) => ({ receipt: b.receipt, proof: batchProof(b, id) }));
  const path = assemblePath(entries, "app:1");
  assert.deepEqual(path.map((x) => x.receipt.thisHop), [node(1), node(2), node(3), node(2), node(4), node(9)]);
  const v = verifyPath(path, { bundleId: id, source: "app:1", destination: node(9), authorize: dir });
  assert.equal(v.ok, true, v.reason);
  assert.equal(v.revisits, 1);
  // Swap two hops' order: the committed times make it a time regression.
  const swapped = [path[0], path[1], path[4], path[3], path[2], path[5]];
  assert.equal(verifyPath(swapped, { bundleId: id, source: "app:1", destination: node(9), authorize: dir }).ok, false);
});

test("leafTimes: batches without times are unchanged", () => {
  const a = batchReceipt(keys[2], { prevHop: node(1), thisHop: node(2), contactId: "c", from: 1, to: 2, bundleIds: ["0xb1"] });
  assert.equal(a.receipt.leafTimes, undefined);
  assert.equal(batchProof(a, "0xb1").t, undefined);
  assert.equal(inBatch(a.receipt, "0xb1", batchProof(a, "0xb1")), true);
});
