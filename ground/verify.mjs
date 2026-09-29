#!/usr/bin/env node
// Verify one station ledger under a pinned key, optionally re-hashing the products, and
// optionally corroborate against a second station's ledger.
//
//   node ground/verify.mjs <ledger.json> --pub <station pub> [--files <dir>]
//        [--with <ledger2.json> --pub2 <station2 pub>]
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { verifyLedger, corroborate } from "./lib.mjs";

const arg = (n) => { const i = process.argv.indexOf(`--${n}`); return i > 0 ? process.argv[i + 1] : undefined; };
const file = process.argv[2];
if (!file || file.startsWith("--")) { console.log("usage: node ground/verify.mjs <ledger.json> --pub <key> [--files <dir>] [--with <ledger2.json> --pub2 <key>]"); process.exit(0); }

const readDir = (dir) => {
  const m = new Map();
  (function walk(d) { for (const n of readdirSync(d)) { const p = join(d, n); statSync(p).isDirectory() ? walk(p) : m.set(relative(dir, p).split("\\").join("/"), readFileSync(p)); } })(dir);
  return m;
};

const a = JSON.parse(readFileSync(file, "utf8"));
const va = verifyLedger(a, { stationPub: arg("pub"), files: arg("files") ? readDir(arg("files")) : undefined });
console.log(`${a.station}: ${va.ok ? "PASS" : "FAIL"} ${JSON.stringify(va)}`);
let fails = va.ok ? 0 : 1;

if (arg("with")) {
  const b = JSON.parse(readFileSync(arg("with"), "utf8"));
  const vb = verifyLedger(b, { stationPub: arg("pub2") });
  console.log(`${b.station}: ${vb.ok ? "PASS" : "FAIL"} ${JSON.stringify(vb)}`);
  if (!vb.ok) fails++;
  if (va.ok && vb.ok) {
    const c = corroborate(a, b);
    console.log(`corroborated by both stations: ${c.corroborated.length}; only ${a.station}: ${c.onlyA.length}; only ${b.station}: ${c.onlyB.length}`);
  }
}
console.log(fails ? "VERIFY: FAIL" : "VERIFY: PASS");
process.exit(fails ? 1 : 0);
