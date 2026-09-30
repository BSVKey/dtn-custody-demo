// Real-orbit topology from public TLEs (three Starlink element sets embedded; public data).
import test from "node:test";
import assert from "node:assert/strict";
import { parseTles, makeOrbitalConstellation } from "../constellation/orbits.mjs";

const TLE = [
  "STARLINK-1008",
  "1 44714U 19074B   26272.64426869  .00027367  00000+0  27039-3 0  9993",
  "2 44714  53.1456 282.2014 0002796  81.7596 278.3737 15.65709810380500",
  "STARLINK-1012",
  "1 44718U 19074F   26272.63105186  .00027765  00000+0  27143-3 0  9990",
  "2 44718  53.1483 282.4697 0005621  29.4584 330.6748 15.65955933380490",
  "STARLINK-1017",
  "1 44723U 19074L   26272.69750892  .00034307  00000+0  85005-3 0  9993",
  "2 44723  53.0431 298.3411 0005202  25.4456 334.6803 15.40096678380241",
].join("\n");

test("orbits: TLEs parse, propagate with SGP4 and give symmetric geometric links", () => {
  const tles = parseTles(TLE);
  assert.equal(tles.length, 3);
  const c = makeOrbitalConstellation({ tles, count: 3, startTime: new Date(Date.UTC(2026, 8, 30, 6, 0, 0)), maxIslKm: 50000, minAltKm: 200, maxAltKm: 2000 });
  assert.equal(c.sats.length, 3);
  const t = c.topology(0);
  assert.equal(t.adj.length, 3);
  for (const [i, nbrs] of t.adj.entries()) for (const j of nbrs) assert.ok(t.adj[j].includes(i), "links are symmetric");
  assert.equal(c.stats[0].links, t.adj.reduce((a, n) => a + n.length, 0) / 2);
  assert.equal(c.topology(0), t, "each epoch is computed once");
});
