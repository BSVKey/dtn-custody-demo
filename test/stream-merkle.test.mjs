import { test } from "node:test";
import assert from "node:assert/strict";
import { leafHash, buildTree, proof, verifyProof } from "../agent/lib/merkle.mjs";
import { StreamMerkle, leafOf } from "../agent/lib/stream-merkle.mjs";

const leaves = (n) => Array.from({ length: n }, (_, i) => leafHash(Buffer.from(`bundle ${i}`)));

test("stream merkle: same root and same proofs as merkle.mjs for every size 1..70 and every leaf", () => {
  for (let n = 1; n <= 70; n++) {
    const ls = leaves(n), tree = buildTree(ls), st = new StreamMerkle();
    for (const l of ls) st.add(Buffer.from(l, "hex"), { watch: true });
    assert.equal(st.root().toString("hex"), tree.root, `root n=${n}`);
    for (let i = 0; i < n; i++) {
      assert.deepEqual(st.proof(i), proof(tree, i), `proof n=${n} i=${i}`);
      assert.ok(verifyProof(ls[i], st.proof(i), i, tree.root));
    }
  }
});

test("stream merkle: larger trees with a few watched leaves; leafOf matches leafHash; misuse refused", () => {
  for (const n of [1000, 1023, 1025, 4097]) {
    const ls = leaves(n), tree = buildTree(ls), st = new StreamMerkle(), watched = [0, 1, n >> 1, n - 2, n - 1];
    ls.forEach((l, i) => st.add(Buffer.from(l, "hex"), { watch: watched.includes(i) }));
    assert.equal(st.root().toString("hex"), tree.root);
    for (const i of watched) assert.deepEqual(st.proof(i), proof(tree, i));
    assert.equal(st.proof(5), null, "unwatched leaf has no proof");
  }
  assert.equal(leafOf(Buffer.from("x")).toString("hex"), leafHash(Buffer.from("x")));
  const st = new StreamMerkle();
  assert.throws(() => st.root(), /no leaves/);
  assert.throws(() => st.add(Buffer.alloc(31)), /32-byte/);
  st.add(Buffer.alloc(32)); st.root();
  assert.throws(() => st.add(Buffer.alloc(32)), /closed/);
});
