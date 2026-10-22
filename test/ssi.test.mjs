// The accountable Solar System Internet run (ssi/): geometry gives sane light times, every
// bundle is delivered and verified except the one carrying a stolen key, every forged claim
// is refused for the right reason, unsigned carriage earns nothing, statements verify.
import { test } from "node:test";
import assert from "node:assert/strict";
import { runSSI } from "../ssi/run.mjs";
import { route } from "../ssi/cgr.mjs";
import { NODES } from "../ssi/world.mjs";

const { result: r, contacts } = runSSI();

test("ssi: light times from geometry are the Moon's and Mars's", () => {
  const lunar = contacts.filter((c) => NODES[c.from].kind === "station" && NODES[c.to].kind === "lunar-orbiter");
  const mars = contacts.filter((c) => NODES[c.from].kind === "station" && NODES[c.to].kind === "mars-orbiter");
  assert.ok(lunar.length && lunar.every((c) => c.owltMs > 1150 && c.owltMs < 1400), "Earth-Moon about 1.2-1.4 s");
  assert.ok(mars.length && mars.every((c) => c.owltMs > 3 * 60e3 && c.owltMs < 23 * 60e3), "Earth-Mars 3-22 min");
  assert.ok(!contacts.some((c) => c.from === "ipn:50.0" && NODES[c.to].kind === "station"), "the far-side lander never sees Earth");
});

test("ssi: every bundle is delivered; the destination refuses only the stolen-key one", () => {
  assert.equal(r.bundles.delivered, r.bundles.sent);
  assert.equal(r.bundles.undelivered, 0);
  assert.equal(r.verifiedAtDestination, r.bundles.delivered - r.compromise.staleKeyDeliveries);
  assert.equal(r.compromise.acceptedAtDestinationBeforeTheyHeard, 0);
  assert.ok(Object.values(r.signedPlans).every((p) => p.ok));
});

test("ssi: the revocation reaches spacecraft through traffic, after the ground", () => {
  const p = Object.fromEntries(r.compromise.propagation.map((x) => [x.node, x.heardAfterH]));
  assert.equal(p["ipn:1.0"], 0);
  for (const sc of ["ipn:20.0", "ipn:21.0", "ipn:40.0", "ipn:50.0", "ipn:60.0"]) assert.ok(p[sc] > 0, `${sc} hears later`);
  assert.ok(r.compromise.victimSwitchedKeyAfterH > 0);
});

test("ssi: every forged claim is refused for its own reason", () => {
  assert.deepEqual(r.forgeries.map((f) => f.outcome), [
    "revoked_unwitnessed", "chain_digest_mismatch", "signed_after_revocation", "bundle_never_delivered", "earned nothing extra (already credited)",
  ]);
});

test("ssi: settlement pays signed carriage only, in verifiable statements", () => {
  assert.equal(r.settlement.lunaB.amount, 0);
  assert.ok(r.unsignedHopsByOperator.lunaB > 0);
  for (const op of ["ground", "lunaA", "marsnet"]) assert.ok(r.settlement[op].amount > 0 && r.settlement[op].statement);
  assert.equal(r.statementsVerify, true);
});

test("cgr: earliest arrival, through a relay when the direct link is later", () => {
  const c = (from, to, start, end, owltMs) => ({ from, to, start, end, rateBps: 8e6, owltMs });
  const plan = [c("a", "d", 100000, 200000, 10), c("a", "b", 0, 50000, 10), c("b", "d", 1000, 50000, 10)];
  const r1 = route(plan, "a", "d", 0, 1000);
  assert.deepEqual(r1.hops.map((h) => h.to), ["b", "d"]);
  assert.equal(route(plan, "a", "d", 60000, 1000).hops[0].to, "d");
  assert.equal(route(plan, "a", "x", 0, 1000), null);
});
