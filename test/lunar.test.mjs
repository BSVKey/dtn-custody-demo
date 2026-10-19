import { test } from "node:test";
import assert from "node:assert/strict";
import { lunanetRun, auditLightTime, lightMs, EID } from "../lunar/lunanet.mjs";
import { moonDistanceKm, minEarthMoonLightMs } from "../lunar/ephemeris.mjs";

test("lunar: three providers sign across an occultation; the non-signing surface relay is reported as a gap", () => {
  const r = lunanetRun();
  assert.equal(r.chain.ok, true);
  assert.equal(r.chain.custodied, 3);
  assert.deepEqual(r.chain.gaps, [{ afterHop: EID.lander, beforeHop: EID.orbiter, lastUnsigned: EID.surface }]);
  assert.equal(r.bib.ok, true);
});

test("lunar: receipts respect the Earth-Moon light time", () => {
  const r = lunanetRun();
  assert.equal(r.timing.ok, true);
  const trunk = r.timing.findings.find((f) => f.from === EID.orbiter);
  assert.ok(trunk.actualMs >= trunk.minMs);
  assert.ok(Math.abs(r.trunkMs - lightMs(r.trunkKm)) < 1e-9);
});

test("lunar: a receipt claiming receipt faster than light is caught even though it is validly signed", () => {
  const r = lunanetRun({ backdateGroundMs: 900 });
  assert.equal(r.chain.ok, true, "the signature is genuine; the claim is impossible");
  assert.equal(r.timing.ok, false);
  assert.equal(r.timing.findings.find((f) => f.to === EID.ground).ok, false);
});

test("lunar: clock tolerance absorbs small offsets between providers", () => {
  const r = lunanetRun({ backdateGroundMs: 20 });
  const floor = { [`${EID.orbiter}>${EID.ground}`]: r.trunkMs };
  assert.equal(auditLightTime(r.bytes, floor, { toleranceMs: 50 }).ok, true);
  assert.equal(auditLightTime(r.bytes, floor, { toleranceMs: 0 }).ok, false);
});

test("ephemeris: reproduces Meeus example 47.a (1992 April 12, 0h TD: 368,409.7 km)", () => {
  assert.ok(Math.abs(moonDistanceKm(Date.parse("1992-04-12T00:00:00Z")) - 368409.7) < 0.5);
});

test("ephemeris: the 2026 distance stays inside the Moon's perigee and apogee band", () => {
  let lo = Infinity, hi = 0;
  for (let t = Date.parse("2026-01-01"); t < Date.parse("2027-01-01"); t += 3600e3) {
    const d = moonDistanceKm(t); lo = Math.min(lo, d); hi = Math.max(hi, d);
  }
  assert.ok(lo > 356000 && lo < 358000, `perigee ${lo}`);
  assert.ok(hi > 405500 && hi < 407000, `apogee ${hi}`);
});

test("ephemeris: the light-time floor tracks the Moon (about 166 ms between perigee and apogee)", () => {
  const near = minEarthMoonLightMs(Date.parse("2026-11-02T14:00:00Z")), far = minEarthMoonLightMs(Date.parse("2026-11-20T00:00:00Z"));
  assert.ok(near > 1150 && near < 1350 && far > 1150 && far < 1350);
  assert.notEqual(Math.round(near), Math.round(far));
});
