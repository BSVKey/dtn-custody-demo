// Constellation simulation at test scale: changing routes, batch receipts, every bundle verified.
import test from "node:test";
import assert from "node:assert/strict";
import { makeConstellation, simulate, verifyAll } from "../constellation/sim.mjs";

test("constellation: rerouted, stored and batched bundles all verify end to end", () => {
  const c = makeConstellation({ planes: 10, perPlane: 10, stations: 3 });
  const r = simulate(c, { bundles: 400, epochs: 60, failRate: 0.3, stationUpRate: 0.4 });
  assert.equal(r.stranded.length, 0);
  assert.ok(r.waited > 0, "some bundles waited in storage");
  assert.ok(r.crossedEpoch > 0, "some bundles were rerouted mid-transfer");
  assert.ok(r.batches.length < r.hopEvents, "batches cover several bundles");
  const v = verifyAll(c, r);
  assert.equal(v.verified, 400);
  assert.equal(v.failed, 0);
});
