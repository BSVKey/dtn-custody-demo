// Mars solar conjunction (ssi/conjunction): the geometry and the routes, fast; the full run with
// bundles and clearing is `make ssi-conjunction`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { marsPos, sunAngle, sunEarthLagrange, sunPos, vec } from "../ssi/ephem.mjs";
import { computeContacts, AU } from "../ssi/conjunction/world.mjs";
import { route } from "../ssi/cgr.mjs";
import { blackout } from "../ssi/conjunction/run.mjs";

test("the model's 2023 conjunction matches NASA's command moratorium (Nov 11-25, 2023)", () => {
  const under = [];
  for (let t = Date.parse("2023-10-15"); t < Date.parse("2023-12-20"); t += 36e5) if (sunAngle(t, [0, 0, 0], marsPos(t)) < 2) under.push(t);
  assert.equal(new Date(under[0]).toISOString().slice(0, 10), "2023-11-11");
  assert.equal(new Date(under.at(-1)).toISOString().slice(0, 10), "2023-11-24");
});

test("L5 rides Earth's orbit 60 degrees behind Earth, and sees Mars far from the Sun at conjunction", () => {
  const t = Date.parse("2028-03-21T00:00:00Z"), L5 = sunEarthLagrange(t, -60), S = sunPos(t);
  const au = (a) => vec.len(a) / AU;
  assert.ok(Math.abs(au(L5) - au(S)) < 0.001 && Math.abs(au(vec.sub(L5, S)) - au(S)) < 0.001, "equilateral with the Sun and Earth");
  assert.ok(sunAngle(t, [0, 0, 0], marsPos(t)) < 1, "from Earth, Mars is within 1 degree of the Sun");
  assert.ok(sunAngle(t, L5, marsPos(t)) > 30, "from L5, more than 30 degrees");
});

test("March 2028: a 17-day Earth-Mars blackout at the 2 degree limit; via L5 a route from the rover exists throughout", () => {
  const start = Date.parse("2028-03-01T00:00:00Z");
  const direct = computeContacts(start, 40, { relay: false }), withL5 = computeContacts(start, 40, { relay: true });
  const out = blackout(direct);
  assert.ok(out.days > 16 && out.days < 18, `blackout ${out.days} days`);
  for (let t = out.from + 864e5; t < out.to - 864e5; t += 2 * 864e5) {
    assert.equal(route(direct, "ipn:60.0", "ipn:1.0", t, 100000)?.arrival < out.to, false, "no direct route inside the blackout");
    const r = route(withL5, "ipn:60.0", "ipn:1.0", t, 100000);
    assert.ok(r && r.arrival - t < 24 * 36e5 && r.hops.some((c) => c.to === "ipn:70.0"), `via L5 within a day at ${new Date(t).toISOString()}`);
  }
});
