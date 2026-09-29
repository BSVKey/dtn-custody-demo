// Compare the C implementation's output with the published test vectors and verify its
// records with the reference verifier. Usage: ./vectors | node flight/check.mjs
import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
import { verifyRecord } from "../agent/lib/receipt.mjs";

const c = JSON.parse(readFileSync(0, "utf8"));
const v = JSON.parse(readFileSync(new URL("../spec/test-vectors.json", import.meta.url), "utf8"));
const checks = [];
const check = (name, fn) => { try { fn(); checks.push([name, true]); } catch (e) { checks.push([name, false, e.message.split("\n")[0]]); } };

check("Merkle leaf hashes match", () => assert.deepEqual(c.merkle.leafHashes, v.merkle.leafHashes));
check("Merkle root matches", () => assert.equal(c.merkle.root, v.merkle.root));
check("public keys from seeds match", () => { assert.equal(c.pubs.source, v.keys.source.pubSpkiB64); assert.equal(c.pubs.relay, v.keys.relay.pubSpkiB64); });
check("manifest/1 record identical, signature included", () => assert.deepEqual(c.manifest, v.records.manifest));
check("custody/1 record identical, signature included", () => assert.deepEqual(c.custody, v.records.custody));
check("records verify with the reference verifier", () => { assert.equal(verifyRecord(c.manifest).ok, true); assert.equal(verifyRecord(c.custody).ok, true); });
check("unsafe strings, oversize numbers, short buffers refused", () => assert.deepEqual(c.guards, { quoteRefused: 1, numberRefused: 1, smallBufferRefused: 1 }));

for (const [n, ok, why] of checks) console.log(`  ${n.padEnd(52)} ${ok ? "PASS" : "FAIL  " + why}`);
const ok = checks.every((x) => x[1]);
console.log(`FLIGHT_RESULT ${JSON.stringify({ ok, custodyReceiptsPerSec: c.timing.custodyReceiptsPerSec })}`);
process.exit(ok ? 0 : 1);
