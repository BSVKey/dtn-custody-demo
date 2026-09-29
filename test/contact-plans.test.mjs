// Contact-plan compiler: our mission plans -> NASA HDTN JSON and JPL ION admin lines, and
// the simulator plan. Offline, deterministic.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { normalize, toHdtn, toIon, toSimPlan } from "../contact-plans/compile.mjs";
import { simulate, defaultSimPlan } from "../transport/sim.mjs";
import { genKeypair } from "../agent/lib/keys.mjs";
import { prepare } from "../agent/source.mjs";
import { makeRelay } from "../agent/relay.mjs";

const load = (n) => JSON.parse(readFileSync(new URL(`../contact-plans/${n}.json`, import.meta.url), "utf8"));
const PLANS = ["moon-occultation", "l1-solar-wind", "mars-relay", "uranus-latency"];

test("every shipped plan normalizes and compiles to both NASA formats", () => {
  for (const n of PLANS) {
    const p = load(n);
    const h = toHdtn(p);
    assert.equal(h.contacts.length, p.contacts.length, n);
    for (const c of h.contacts) {
      for (const k of ["contact", "source", "dest", "startTime", "endTime", "rateBitsPerSec", "owlt"]) assert.ok(Number.isInteger(c[k]), `${n}.${k}`);
      assert.ok(c.endTime > c.startTime, n);
    }
    const ion = toIon(p).split("\n").filter((l) => l.startsWith("a "));
    assert.equal(ion.length, p.contacts.length * 2, n);
    assert.ok(ion.every((l) => /^a (contact|range) \+\d+ \+\d+ \d+ \d+ \d+$/.test(l)), n);
  }
});

test("light time is carried in whole seconds, from the real (unscaled) plan by default", () => {
  const owlt = (n, link) => toHdtn(load(n)).contacts.find((c, i) => load(n).contacts[i].link === link).owlt;
  assert.equal(owlt("l1-solar-wind", "L1"), 5);
  assert.equal(owlt("mars-relay", "L2"), 750);
  assert.equal(owlt("uranus-latency", "L1"), 9360);
  assert.equal(owlt("moon-occultation", "L2"), 1);
  assert.equal(toHdtn(load("mars-relay"), { scaled: true }).contacts[1].owlt, 1); // 750 s x 0.001
});

test("the outage appears as a gap between two contacts on the same link", () => {
  const h = toHdtn(load("l1-solar-wind")).contacts.filter((c) => c.source === 1 && c.dest === 2);
  assert.deepEqual(h.map((c) => [c.startTime, c.endTime]), [[0, 600], [780, 1800]]);
});

test("legacy plans (links as names, no nodes) read as a chain 1 -> 2 -> 3", () => {
  const p = normalize({ name: "x", links: ["L1", "L2"], delays: { L1: { one_way_ms: 1000 }, L2: { one_way_ms: 1000 } }, contacts: [{ link: "L1", up_s: 0, down_s: 10 }] });
  assert.deepEqual(p.links.map((l) => [l.from, l.to]), [[1, 2], [2, 3]]);
  assert.deepEqual(p.nodes.map((n) => n.ipn), [1, 2, 3]);
});

test("bad plans are refused with a reason", () => {
  const base = { name: "x", links: ["L1"], delays: { L1: { one_way_ms: 1 } } };
  assert.throws(() => normalize({ ...base, contacts: [{ link: "L9", up_s: 0, down_s: 1 }] }), /unknown link L9/);
  assert.throws(() => normalize({ ...base, contacts: [{ link: "L1", up_s: 5, down_s: 5 }] }), /must end after/);
  assert.throws(() => normalize({ ...base, delays: {}, contacts: [{ link: "L1", up_s: 0, down_s: 1 }] }), /no delay for link L1/);
});

test("every shipped plan drives the simulator: per-link delays, gap on the right link, all chunks delivered", () => {
  for (const n of PLANS) {
    const kp = genKeypair();
    const { bundles } = prepare(kp, Buffer.from("x".repeat(640)), { payloadId: "0xp", chunkSize: 64 });
    const plan = toSimPlan(load(n), defaultSimPlan, { bundles: bundles.length });
    assert.equal(plan.linkDelayMs[load(n).occultation.link] > 0, true, n);
    const relays = { [plan.hops[1]]: makeRelay(genKeypair(), plan.hops[1]), [plan.hops[2]]: makeRelay(genKeypair(), plan.hops[2]) };
    const sim = simulate({ plan, bundles, relays });
    assert.equal(sim.arrivalOrder.length, bundles.length, n);
    assert.equal(sim.occultedLink, load(n).occultation.link, n);
    assert.ok(sim.delayed.length > 0, `${n}: some bundles held by the outage`);
  }
});

test("generated files in contact-plans/generated match the compiler output", () => {
  const dir = new URL("../contact-plans/generated/", import.meta.url);
  for (const n of PLANS) {
    assert.deepEqual(JSON.parse(readFileSync(new URL(`${n}.hdtn.json`, dir), "utf8")), toHdtn(load(n)), n);
    assert.equal(readFileSync(new URL(`${n}.ionrc`, dir), "utf8"), toIon(load(n)), n);
  }
  assert.equal(readdirSync(dir).length, PLANS.length * 2);
});

test("hardy: compiles one-shot TVR windows at absolute UTC times, covering reached destinations", async () => {
  const { toHardy } = await import("../contact-plans/compile.mjs");
  const { readFileSync } = await import("node:fs");
  const plan = JSON.parse(readFileSync(new URL("../hardy/interop.json", import.meta.url), "utf8"));
  const out = toHardy(plan, { epochMs: Date.parse("2026-10-01T00:00:00Z") }).split("\n").filter((l) => l && !l.startsWith("#"));
  assert.deepEqual(out, [
    "ipn:30.* via ipn:30.0 start 2026-10-01T00:00:00Z end 2026-10-01T00:00:15Z bandwidth 100M",
    "ipn:2.* via ipn:30.0 start 2026-10-01T00:00:00Z end 2026-10-01T00:00:15Z bandwidth 100M",
    "ipn:30.* via ipn:30.0 start 2026-10-01T00:00:35Z end 2026-10-01T00:10:00Z bandwidth 100M",
    "ipn:2.* via ipn:30.0 start 2026-10-01T00:00:35Z end 2026-10-01T00:10:00Z bandwidth 100M",
  ]);
  assert.throws(() => toHardy(plan, {}), /epochMs/);
});
