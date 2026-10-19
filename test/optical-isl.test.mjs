import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("optical ISL sim: receipts and the gap audit across fades, a cross-plane handoff and an unaware relay", () => {
  const dir = mkdtempSync(join(tmpdir(), "optical-isl-")), out = join(dir, "r.json");
  try {
    const r = spawnSync(process.execPath, ["constellation/optical-isl.mjs", "--class", "2.5G", "--duration", "60", "--samples", "30", "--seed", "3", "--json", out], { encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
    const R = JSON.parse(readFileSync(out, "utf8"));
    const per = R.perBundleAudit, bat = R.batchAudit;
    assert.equal(R.delivered, R.bundles, "custody held every bundle across the outages and the handoff");
    assert.ok(R.viaC2 > 0 && R.peakHeldAtB > 0, "traffic waited at B for the new cross-plane link, then went through the unaware relay");
    // The tampered bundle fails both audits; everything else agrees between the two modes.
    assert.deepEqual(per.reasons, { payload_hash_mismatch: 1 });
    assert.equal(bat.contentMismatch, 1);
    assert.equal(bat.badSig, 0);
    assert.ok(per.complete > 0 && per.complete === bat.complete);
    assert.ok(per.gapViaC2 > 0 && per.gapViaC2 === bat.gapViaC2 && per.gaps === bat.gaps);
    assert.equal(per.complete + per.gaps + per.failed, R.sampled);
    assert.ok(R.batchReceipts < 20, "a few batch receipts per node, one per contact");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
