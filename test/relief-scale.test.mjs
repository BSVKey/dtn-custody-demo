// The regional-scale relief run (relief/scale), small configuration: every delivered bundle
// verifies, and each of the six attacks is caught for exactly the bundles it touches.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const summary = JSON.parse(execFileSync(process.execPath, [fileURLToPath(new URL("../relief/scale/run.mjs", import.meta.url)), "--small", "--json"], { encoding: "utf8" }));

test("relief scale: every delivered bundle verifies across changing routes and outages", () => {
  assert.equal(summary.ok, true);
  assert.equal(summary.verified, summary.delivered);
  assert.equal(summary.failures, 0);
  assert.ok(summary.rerouted > 0 && summary.heldThroughOutage > 0, "the run exercises reroutes and outages");
  assert.equal(summary.signatureChecks, summary.batchReceipts, "each batch record is checked once");
});

test("relief scale: six attacks, each caught for exactly the bundles it touches", () => {
  assert.equal(summary.attacks.length, 6);
  for (const a of summary.attacks) {
    assert.equal(a.pass, true, a.name);
    assert.equal(a.caught, a.affected, a.name);
  }
});
