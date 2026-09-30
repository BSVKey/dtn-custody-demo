#!/usr/bin/env node
// Self-contained walk-through of the pilot kit with simulated passes. Two ground stations
// receive downlinks from one spacecraft over four scheduled passes; station A misses
// pass 2 entirely, and pass 4 is silent at both. Each writes a ledger with the real CLI, the ledgers are verified and
// corroborated (products and passes: A's missed pass is located at A, since B heard it,
// and the pass neither station heard is recorded as shared silence),
// and one product is then altered on disk to show it is caught.
//   node ground/demo.mjs
import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const here = fileURLToPath(new URL(".", import.meta.url));
const node = (script, args) => execFileSync(process.execPath, [join(here, script), ...args], { encoding: "utf8" });
const T0 = Date.parse("2026-10-01T00:00:00Z");
const min = 60_000;
const passes = [
  { passId: "P1", start: T0, end: T0 + 10 * min },
  { passId: "P2", start: T0 + 95 * min, end: T0 + 105 * min },
  { passId: "P3", start: T0 + 190 * min, end: T0 + 200 * min },
  { passId: "P4", start: T0 + 285 * min, end: T0 + 295 * min }, // neither station hears this one
];
const products = [
  { name: "img-0001.bin", pass: 0, size: 300_000 },
  { name: "tlm-0001.bin", pass: 0, size: 12_000 },
  { name: "img-0002.bin", pass: 1, size: 280_000 },
  { name: "img-0003.bin", pass: 2, size: 310_000 },
];
const bytesOf = (p) => Buffer.from(Array.from({ length: p.size }, (_, i) => (i * 31 + p.name.length * 7) & 255));

const work = mkdtempSync(join(tmpdir(), "ground-demo-"));
try {
  const run = (station, skipPass) => {
    const dir = join(work, station, "recv");
    mkdirSync(dir, { recursive: true });
    const received = {};
    products.forEach((p, i) => {
      if (p.pass === skipPass) return;
      writeFileSync(join(dir, p.name), bytesOf(p));
      received[p.name] = passes[p.pass].start + (2 + i) * min;
    });
    writeFileSync(join(work, station, "passes.json"), JSON.stringify({ passes, received }, null, 2));
    const key = join(work, station, "key.json");
    const out = node("station.mjs", ["--in", dir, "--passes", join(work, station, "passes.json"), "--station", `ipn:${station === "gs-a" ? 20 : 21}.0`, "--spacecraft", "ipn:5.0", "--key", key, "--out", join(work, station, "ledger.json")]);
    process.stdout.write(out);
    return { dir, ledger: join(work, station, "ledger.json"), pub: out.match(/pin this\): (\S+)/)[1] };
  };
  console.log("== two stations write ledgers from what they received ==");
  const a = run("gs-a", 1);
  const b = run("gs-b", -1);

  console.log("\n== verify both under pinned keys, re-hash A's products, corroborate ==");
  process.stdout.write(node("verify.mjs", [a.ledger, "--pub", a.pub, "--files", a.dir, "--with", b.ledger, "--pub2", b.pub]));

  console.log("\n== alter one received product on disk and verify again ==");
  appendFileSync(join(a.dir, "img-0001.bin"), Buffer.from([0]));
  try { node("verify.mjs", [a.ledger, "--pub", a.pub, "--files", a.dir]); console.log("UNEXPECTED: alteration not detected"); process.exitCode = 1; }
  catch (e) { process.stdout.write(e.stdout); console.log("(expected: the altered product is detected)"); }
} finally {
  rmSync(work, { recursive: true, force: true });
}
