// Check the CUSTODY app's output: the record signed with the published test key must equal
// the published vector exactly; the second record must verify; the malformed commands must
// have produced no records and error events.
import { readFileSync, readdirSync } from "node:fs";
import assert from "node:assert/strict";
import { verifyRecord } from "../../agent/lib/receipt.mjs";

const dir = process.argv[2];
const log = readFileSync("/tmp/cfs.log", "utf8");
const v = JSON.parse(readFileSync(new URL("../../spec/test-vectors.json", import.meta.url), "utf8"));
const files = readdirSync(dir).filter((f) => /^custody_\d+\.json$/.test(f)).sort();
const recs = files.map((f) => JSON.parse(readFileSync(`${dir}/${f}`, "utf8")));
const checks = [];
const check = (name, fn) => { try { fn(); checks.push([name, true]); } catch (e) { checks.push([name, false, e.message.split("\n")[0]]); } };

check("self-test passed at boot inside cFS", () => assert.match(log, /CUSTODY self-test PASS/));
check("exactly two records written (bad commands refused)", () => assert.equal(recs.length, 2));
check("record 1 identical to the published custody/1 vector", () => assert.deepEqual(recs[0], v.records.custody));
check("record 2 verifies with the reference verifier", () => {
  const r = verifyRecord(recs[1]);
  assert.equal(r.ok, true);
  assert.equal(r.signer, v.keys.relay.pubSpkiB64);
  assert.equal(recs[1].thisHop, "ipn:20.0");
});
check("unterminated field refused with an error event", () => assert.match(log, /CUSTODY sign: unterminated string field/));
check("unsafe string refused with an error event", () => assert.match(log, /CUSTODY sign: record refused \(code -1\)/));
check("NOOP reports 2 signed, 2 errors", () => assert.match(log, /CUSTODY NOOP: 2 signed, 2 errors/));

for (const [n, ok, why] of checks) console.log(`  ${n.padEnd(58)} ${ok ? "PASS" : "FAIL  " + why}`);
const ok = checks.every((c) => c[1]);
console.log(`CFS_RESULT ${JSON.stringify({ ok, records: recs.length })}`);
process.exit(ok ? 0 : 1);
