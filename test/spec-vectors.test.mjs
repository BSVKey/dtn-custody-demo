// The published test vectors (spec/test-vectors.json) must equal what the reference
// implementation produces today, and every signed record in them must verify.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { buildVectors } from "../spec/vectors.mjs";
import { verifyRecord } from "../agent/lib/receipt.mjs";
import { leafHash, buildTree, verifyProof } from "../agent/lib/merkle.mjs";

const published = JSON.parse(readFileSync(new URL("../spec/test-vectors.json", import.meta.url), "utf8"));

test("published vectors match the reference implementation byte for byte", () => {
  assert.deepEqual(JSON.parse(JSON.stringify(buildVectors())), published);
});

test("every signed record in the vectors verifies under its declared test key", () => {
  const { records, keys } = published;
  const expect = { manifest: keys.source.pubSpkiB64, custody: keys.relay.pubSpkiB64, delivery: keys.dest.pubSpkiB64 };
  for (const [name, pub] of Object.entries(expect)) {
    const v = verifyRecord(records[name]);
    assert.equal(v.ok, true, name);
    assert.equal(v.signer, pub, name);
  }
});

test("the manifest root re-derives from the payload in the vectors", () => {
  const p = Buffer.from(published.records.payloadUtf8, "utf8");
  const leaves = [];
  for (let i = 0; i < p.length; i += published.records.chunkSize) leaves.push(leafHash(p.subarray(i, i + published.records.chunkSize)));
  assert.equal(buildTree(leaves).root, published.records.manifest.root);
  const m = published.merkle;
  assert.equal(verifyProof(m.leafHashes[2], m.proofIndex2.branch, 2, m.root), true);
});
