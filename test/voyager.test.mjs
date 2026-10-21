// Voyager 1 run (voyager/): both directions complete and verify, every space hop takes
// exactly one light time, nothing is heard outside a DSN track, and the link model holds
// bundles that don't fit in a window.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { runPath, shiftWindows } from "../voyager/link.mjs";

test("voyager run passes in both directions", () => {
  const out = execFileSync(process.execPath, ["voyager/run-voyager.mjs", "--json"], { encoding: "utf8" });
  const r = JSON.parse(out.split("VOYAGER_RESULT ")[1]);
  assert.equal(r.ok, true);
  for (const d of [r.downlink, r.uplink]) {
    assert.equal(d.accepted, d.bundles);
    assert.equal(d.custodyChains, d.bundles);
    assert.equal(d.payloadMatches, true);
    assert.ok(d.heldByGaps.reduce((a, b) => a + b, 0) > 0, "the schedule should hold some bundles");
  }
  assert.equal(r.tamperRejected, true);
});

test("link model: a bundle that would miss the window is held to the next one", () => {
  const H = 3.6e6;
  const tracks = [[10 * H, 12 * H], [34 * H, 36 * H]];
  const stamp = () => ({});
  const bundle = (i) => ({ bundleId: "b" + i, index: i });
  const run = runPath({
    hops: ["a", "b", "c"], relays: { b: { stamp } },
    links: [
      { id: "L1", owltMs: 5 * H, bps: 1000, windows: shiftWindows(tracks, -5 * H) },
      { id: "L2", owltMs: 0, bps: 1e9, windows: null },
    ],
    // 2 x 3,600,000 bits at 1 kbps = 1 h each; only one fits before the window closes.
    items: [0, 1].map((i) => ({ bundle: bundle(i), bytes: 450000, readyAt: 6 * H })),
  });
  const [l0, l1] = run.legs.map((l) => l[0]);
  assert.equal(l0.txStart, 6 * H);
  assert.equal(l0.arriveAt, 12 * H);           // lands at the end of the first track
  assert.equal(l1.txStart, 29 * H);            // held to the next window
  assert.equal(l1.arriveAt - l1.txEnd, 5 * H); // exactly one light time
  for (const leg of [l0, l1]) {
    assert.ok(tracks.some(([s, e]) => leg.arriveAt - 1 * H >= s && leg.arriveAt <= e), "heard inside a track");
  }
  assert.deepEqual(run.gaps.map((g) => g.bundlesDelayed), [["b1"]]);
});
