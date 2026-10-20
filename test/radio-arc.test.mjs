// Reading an ARC broadcaster's answer (radio/lib/arc.mjs): the txStatus decides, because ARC can
// answer HTTP 200 for a payment the network will never mine (seen with a demo payment: an orphan).
import { test } from "node:test";
import assert from "node:assert/strict";
import { arcVerdict } from "../radio/lib/arc.mjs";

test("arc: accepted statuses are success; orphans, double spends and rejections are not, even at HTTP 200", () => {
  for (const s of ["SEEN_ON_NETWORK", "ACCEPTED_BY_NETWORK", "SENT_TO_NETWORK", "ANNOUNCED_TO_NETWORK", "STORED", "MINED"]) assert.equal(arcVerdict(200, JSON.stringify({ txStatus: s })).ok, true, s);
  const orphan = arcVerdict(200, JSON.stringify({ txStatus: "SEEN_IN_ORPHAN_MEMPOOL", txid: "2896e7" }));
  assert.equal(orphan.ok, false);
  assert.match(orphan.why, /never seen the coins/);
  assert.match(arcVerdict(200, JSON.stringify({ txStatus: "DOUBLE_SPEND_ATTEMPTED" })).why, /already spent/);
  assert.match(arcVerdict(200, JSON.stringify({ txStatus: "REJECTED", extraInfo: "bad script" })).why, /refused it \(bad script\)/);
  assert.equal(arcVerdict(409, "txn-already-known").ok, true);
  assert.match(arcVerdict(465, JSON.stringify({ title: "Fee too low", status: 465 })).why, /refused \(465\): Fee too low/);
  assert.match(arcVerdict(500, "<html>oops</html>").why, /refused \(500\)/);
});
