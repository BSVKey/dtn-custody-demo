import { test } from "node:test";
import assert from "node:assert/strict";
import { leafHash, buildTree, proof, verifyProof } from "../agent/lib/merkle.mjs";

function leavesFor(n) {
  return Array.from({ length: n }, (_, i) => leafHash(Buffer.from(`chunk-${i}`)));
}

test("every leaf verifies against the root (even and odd counts)", () => {
  for (const n of [1, 2, 3, 5, 8, 17]) {
    const leaves = leavesFor(n);
    const tree = buildTree(leaves);
    for (let i = 0; i < n; i++) {
      assert.equal(verifyProof(leaves[i], proof(tree, i), i, tree.root), true, `n=${n} i=${i}`);
    }
  }
});

test("a tampered leaf fails its branch", () => {
  const leaves = leavesFor(8);
  const tree = buildTree(leaves);
  const badLeaf = leafHash(Buffer.from("tampered"));
  assert.equal(verifyProof(badLeaf, proof(tree, 3), 3, tree.root), false);
});

test("a valid leaf at the wrong index fails", () => {
  const leaves = leavesFor(8);
  const tree = buildTree(leaves);
  assert.equal(verifyProof(leaves[3], proof(tree, 3), 4, tree.root), false);
});

test("leafHash is domain-separated from internal nodes", () => {
  // A leaf hash of 64 hex chars must not collide with an internal node of the same
  // two children; different prefixes guarantee it. Smoke check: distinct outputs.
  const a = leafHash(Buffer.from("x"));
  const t = buildTree([a, a]);
  assert.notEqual(a, t.root);
});
