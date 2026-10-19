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

test("constellation: optical ISLs re-acquire, sign per contact, and every bundle still verifies", () => {
  const c = makeConstellation({ planes: 10, perPlane: 10, stations: 3 });
  const rf = simulate(c, { bundles: 400, epochs: 60 });
  const r = simulate(c, { bundles: 400, epochs: 60, links: "optical", acqS: 30 });
  assert.equal(r.stranded.length, 0);
  assert.equal(r.optical.acqTicks, 5);
  assert.ok(r.optical.acquisitions > 0 && r.optical.acquireWaits > 0, "bundles waited for links being re-acquired");
  assert.ok(r.optical.maxLinkKm > 0 && r.optical.maxLinkKm <= 5500);
  assert.ok(r.batches.length < rf.batches.length, "one batch per contact, not per epoch");
  const v = verifyAll(c, r);
  assert.equal(v.verified, 400);
  assert.equal(v.failed, 0);
  assert.equal(rf.optical, null);
});

test("constellation: optical link capacity holds bundles back when links are full", () => {
  const c = makeConstellation({ planes: 10, perPlane: 10, stations: 3 });
  const r = simulate(c, { bundles: 400, epochs: 80, links: "optical", bundleBytes: 2 ** 31 });
  assert.equal(r.optical.bundlesPerLinkTick, 3);
  assert.ok(r.optical.capacityWaits > 0);
  assert.equal(r.stranded.length, 0);
  assert.equal(verifyAll(c, r).verified, 400);
});

test("constellation: unknown link mode or rate is refused", () => {
  const c = makeConstellation({ planes: 4, perPlane: 4, stations: 1 });
  assert.throws(() => simulate(c, { links: "laser" }), /unknown links/);
  assert.throws(() => simulate(c, { links: "optical", rate: "1T" }), /unknown links/);
  assert.throws(() => simulate({ ...c, topology: () => null }, { links: "optical" }), /grid model/);
});
