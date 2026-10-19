import { test } from "node:test";
import assert from "node:assert/strict";
import { lunanetRun, auditLightTime, lightMs, EID } from "../lunar/lunanet.mjs";

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
  assert.ok(trunk.actualMs >= Math.floor(lightMs(384400)));
});

test("lunar: a receipt claiming receipt faster than light is caught even though it is validly signed", () => {
  const r = lunanetRun({ backdateGroundMs: 900 });
  assert.equal(r.chain.ok, true, "the signature is genuine; the claim is impossible");
  assert.equal(r.timing.ok, false);
  assert.equal(r.timing.findings.find((f) => f.to === EID.ground).ok, false);
});

test("lunar: clock tolerance absorbs small offsets between providers", () => {
  const r = lunanetRun({ backdateGroundMs: 20 });
  assert.equal(auditLightTime(r.bytes, { [`${EID.orbiter}>${EID.ground}`]: lightMs(384400) }, { toleranceMs: 50 }).ok, true);
  assert.equal(auditLightTime(r.bytes, { [`${EID.orbiter}>${EID.ground}`]: lightMs(384400) }, { toleranceMs: 0 }).ok, false);
});
