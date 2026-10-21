// Voyager runs (voyager/): both spacecraft, both directions complete and verify, link
// windows come only from a signed schedule, nothing is heard outside a track, bundles that
// don't fit are held, and lost bundles are resent after a NACK on the reverse link.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { runPath, shiftWindows } from "../voyager/link.mjs";
import { runMission, MISSIONS } from "../voyager/mission.mjs";
import { missionPlan, signSchedule, windowsFrom, expandTracks } from "../voyager/schedule.mjs";
import { genKeypair } from "../agent/lib/keys.mjs";

const H = 3.6e6;

test("voyager 1 and 2 pass in both directions from a signed schedule", () => {
  for (const key of ["voyager1", "voyager2"]) {
    const r = runMission(key);
    assert.equal(r.ok, true, key);
    assert.equal(r.editRefused, true);
    for (const d of [r.downlink, r.uplink]) {
      assert.equal(d.accepted, d.bundles);
      assert.equal(d.custodyChains, d.bundles);
      assert.equal(d.gapsBacked, true);
      assert.ok(d.heldByGaps.reduce((a, b) => a + b, 0) > 0, "the schedule should hold some bundles");
    }
  }
});

test("cli prints one VOYAGER_RESULT line", () => {
  const out = execFileSync(process.execPath, ["voyager/run-voyager.mjs", "--mission", "voyager2", "--json"], { encoding: "utf8" });
  assert.equal(JSON.parse(out.split("VOYAGER_RESULT ")[1]).ok, true);
});

test("voyager 2 can be commanded only on DSS-43 tracks", () => {
  const tracks = expandTracks(MISSIONS.voyager2.tracks);
  assert.ok(tracks.filter((t) => t.uplink).every((t) => t.station === "DSS-43"));
  assert.equal(tracks.filter((t) => t.uplink).length, 10);
  const plan = missionPlan(MISSIONS.voyager2, MISSIONS.common), kp = genKeypair();
  const rec = signSchedule(kp, plan);
  assert.equal(windowsFrom(rec, plan, kp.pub, "UP").length, 10);
  assert.equal(windowsFrom(rec, plan, kp.pub, "DOWN").length, 30);
  assert.throws(() => windowsFrom(rec, plan, genKeypair().pub, "UP"), /not_signed_by_this_operator/);
});

test("with bit errors, lost bundles are resent and everything still verifies", () => {
  const r = runMission("voyager2", { ber: 1e-5, seed: 2 });
  assert.equal(r.ok, true);
  assert.ok(r.downlink.lostAndResent > 0);
  assert.ok(r.downlink.hoursToLast > runMission("voyager2").downlink.hoursToLast);
});

test("link model: a bundle that would miss the window is held to the next one", () => {
  const tracks = [[10 * H, 12 * H], [34 * H, 36 * H]];
  const stamp = () => ({});
  const run = runPath({
    hops: ["a", "b", "c"], relays: { b: { stamp } },
    links: [
      { id: "L1", owltMs: 5 * H, bps: 1000, windows: shiftWindows(tracks, -5 * H) },
      { id: "L2", owltMs: 0, bps: 1e9, windows: null },
    ],
    // 2 x 3,600,000 bits at 1 kbps = 1 h each; only one fits before the window closes.
    items: [0, 1].map((i) => ({ bundle: { bundleId: "b" + i, index: i }, bytes: 450000, readyAt: 6 * H })),
  });
  const [l0, l1] = run.legs.map((l) => l[0]);
  assert.equal(l0.txStart, 6 * H);
  assert.equal(l0.arriveAt, 12 * H);
  assert.equal(l1.txStart, 29 * H);
  assert.equal(l1.arriveAt - l1.txEnd, 5 * H);
  assert.deepEqual(run.gaps.map((g) => g.bundlesDelayed), [["b1"]]);
});

test("link model: a lost bundle waits for the NACK, then the next window", () => {
  // Loss probability 0.3 per copy; seed 1 draws 0.236 (lost) then 0.369 (delivered).
  const ber = 1 - 0.7 ** (1 / 800);
  const run = runPath({
    hops: ["a", "b"], relays: {},
    links: [{
      id: "L1", owltMs: 5 * H, bps: 1e6, windows: [[0, 2 * H], [20 * H, 22 * H]], ber,
      reverse: { owltMs: 5 * H, bps: 1e6, windows: [[8 * H, 9 * H]] },
    }],
    items: [{ bundle: { bundleId: "x", index: 0 }, bytes: 100, readyAt: 0 }],
    seed: 1,
  });
  const [r] = run.resends;
  assert.equal(r.lastLandedAt, 5 * H + 1);   // lost copy would have landed here
  assert.equal(r.nackSentAt, 8 * H);         // receiver waits for its window
  assert.equal(r.nackArriveAt, 13 * H + 1);  // plus one light time
  const leg = run.legs[0][0];
  assert.equal(leg.attempts, 2);
  assert.equal(leg.txStart, 20 * H);         // sender's next window
  assert.equal(leg.arriveAt, 25 * H + 1);
});

test("link model: ber 1 is reported as never delivered", () => {
  assert.throws(() => runPath({
    hops: ["a", "b"], relays: {},
    links: [{ id: "L1", owltMs: 1000, bps: 1e6, windows: null, ber: 1, reverse: { owltMs: 1000, bps: 1e6, windows: null } }],
    items: [{ bundle: { bundleId: "x", index: 0 }, bytes: 100, readyAt: 0 }],
  }), /after 50 rounds/);
});
