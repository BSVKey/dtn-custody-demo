import test from "node:test";
import assert from "node:assert/strict";
import { parseTles, computePasses, passesToPlan } from "../contact-plans/passes.mjs";
import { toHdtn, toIon, toHardy } from "../contact-plans/compile.mjs";
import { signPlan, verifyPlan, contactAt, planFingerprint } from "../contact-plans/sign.mjs";
import { genKeypair } from "../agent/lib/keys.mjs";

// An International Space Station element set from 1 January 2024 (sample data).
const ISS = `ISS (ZARYA)
1 25544U 98067A   24001.50000000  .00016717  00000-0  10270-3 0  9994
2 25544  51.6416 247.4627 0006703 130.5360 325.0288 15.50377579432066`;
const START = Date.parse("2024-01-01T12:00:00Z");
const stations = [{ name: "Houston", lat: 29.76, lon: -95.37 }, { name: "London", lat: 51.51, lon: -0.13 }, { name: "Svalbard", lat: 78.22, lon: 15.65 }];

test("TLE text with and without name lines", () => {
  const t = parseTles(ISS + "\n" + ISS.split("\n").slice(1).join("\n"));
  assert.equal(t.length, 2);
  assert.equal(t[0].name, "ISS (ZARYA)");
  assert.equal(t[1].name, "NORAD 25544");
});

test("ISS passes over real stations look like real passes", () => {
  const passes = computePasses({ tles: parseTles(ISS), stations, startMs: START, hours: 24, elevationMaskDeg: 10 });
  assert.ok(passes.length >= 4, `only ${passes.length} passes`);
  for (const p of passes) {
    const min = (p.losMs - p.aosMs) / 60000;
    assert.ok(min > 0.2 && min < 12, `pass of ${min} min`);
    assert.ok(p.maxElevationDeg >= 10 && p.maxElevationDeg <= 90);
    assert.ok(p.midRangeKm > 400 && p.midRangeKm < 2500, `range ${p.midRangeKm}`);
  }
  // The ISS orbit (51.6 degrees) never rises above 10 degrees at Svalbard (78 N).
  assert.equal(passes.filter((p) => p.station === "Svalbard").length, 0);
});

test("a pass plan compiles to HDTN, ION and Hardy, and signs and verifies", () => {
  const tles = parseTles(ISS);
  const passes = computePasses({ tles, stations, startMs: START, hours: 12 });
  const plan = passesToPlan(passes, { startMs: START, tles, stations, rateBps: 2000000 });
  const hdtn = toHdtn(plan), ion = toIon(plan), hardy = toHardy(plan, { epochMs: START });
  assert.equal(hdtn.contacts.length, passes.length * 2);
  assert.ok(hdtn.contacts.every((c) => c.endTime > c.startTime && c.owlt >= 0));
  assert.match(ion, /a contact \+\d+ \+\d+ 100 10 250000/);
  const kp = genKeypair();
  const exports = { hdtn: JSON.stringify(hdtn, null, 2), ion, hardy };
  const rec = signPlan(kp, { plan, exports, network: "test-net", version: 1, validFrom: plan.epoch, validTo: new Date(START + 12 * 3600000).toISOString() });
  assert.equal(rec.planFingerprint, planFingerprint(plan));
  assert.equal(verifyPlan(rec, { pub: kp.pub, plan, exports }).ok, true);
  const edited = structuredClone(plan); edited.contacts[0].down_s += 60;
  assert.deepEqual(verifyPlan(rec, { pub: kp.pub, plan: edited }).problems, ["plan_differs_from_signed_plan"]);
  assert.deepEqual(verifyPlan(rec, { pub: kp.pub, exports: { ion: ion + "a contact +1 +2 1 2 3\n" } }).problems, ["ion_file_differs"]);
  assert.deepEqual(verifyPlan(rec, { pub: genKeypair().pub }).problems, ["not_signed_by_this_operator"]);
  const first = plan.contacts[0], link = plan.links.find((l) => l.id === first.link);
  assert.equal(contactAt(plan, link.from, link.to, first.up_s + 1).length, 1);
  assert.equal(contactAt(plan, link.from, link.to, first.down_s + 1).length, 0);
});
