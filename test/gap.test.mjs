import { test } from "node:test";
import assert from "node:assert/strict";
import { gapObject } from "../agent/lib/gap.mjs";

test("gap object records the occultation boundary and the delayed set", () => {
  const g = gapObject({
    link: "L2",
    linkEvents: [
      { link: "L2", event: "down", t: 500 },
      { link: "L2", event: "up", t: 2200 },
      { link: "L1", event: "down", t: 999 }, // other link, ignored
    ],
    delayed: ["0xb3", "0xb1", "0xb2"],
    lost: [],
  });
  assert.equal(g.kind, "gap/1");
  assert.equal(g.link, "L2");
  assert.equal(g.downAt, 500);
  assert.equal(g.upAt, 2200);
  assert.equal(g.durationMs, 1700);
  assert.deepEqual(g.bundlesDelayed, ["0xb1", "0xb2", "0xb3"]); // sorted
  assert.deepEqual(g.bundlesLostConfirmed, []);
});

test("silence is documented, not lost: a confirmed loss is recorded, not hidden", () => {
  const g = gapObject({
    link: "L2",
    linkEvents: [{ link: "L2", event: "down", t: 0 }, { link: "L2", event: "up", t: 100 }],
    delayed: [],
    lost: ["0xdead"],
  });
  assert.deepEqual(g.bundlesLostConfirmed, ["0xdead"]);
});
