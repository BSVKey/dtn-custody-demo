// The disaster-relief walk-through (relief/run.mjs): every report arrives intact and
// readable only by the hub, the power cut is a gap record, relays are paid for proven
// custody only, and an impostor relay is refused.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import { normalize, toIon } from "../contact-plans/compile.mjs";

const run = () => JSON.parse(execFileSync(process.execPath,
  [fileURLToPath(new URL("../relief/run.mjs", import.meta.url)), "--json"], { encoding: "utf8" }));

test("relief: both clinic reports arrive complete and decrypt at the hub", () => {
  const ev = run();
  assert.equal(ev.ok, true);
  assert.equal(ev.clinics.length, 2);
  for (const c of ev.clinics) {
    assert.equal(c.complete, true);
    assert.ok(c.report.patientsSeen > 0 && c.report.urgent.length > 0);
  }
});

test("relief: the satellite power cut is a gap record with bundles delayed and none lost", () => {
  for (const c of run().clinics) {
    assert.equal(c.gap.link, "L3");
    assert.equal(c.gap.durationMs, 70 * 60 * 1000);
    assert.ok(c.gap.bundlesDelayed.length > 0);
    assert.deepEqual(c.gap.bundlesLostConfirmed, []);
  }
});

test("relief: relays are paid for every proven bundle; an impostor is refused", () => {
  const ev = run();
  const total = ev.clinics.reduce((s, c) => s + c.bundles, 0);
  for (const p of Object.values(ev.payouts)) assert.deepEqual(p, { bundles: total, sats: total * 50 });
  assert.deepEqual(ev.refused.map((r) => r.reason), ["signer_not_pinned_hop_key"]);
});

test("relief: the scenario is a valid contact plan that compiles for ION", () => {
  const plan = JSON.parse(readFileSync(new URL("../relief/scenario.json", import.meta.url), "utf8"));
  assert.equal(normalize(plan).nodes.length, 4);
  assert.match(toIon(plan), /a contact/);
});
