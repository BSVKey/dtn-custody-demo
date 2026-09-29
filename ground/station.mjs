#!/usr/bin/env node
// Ground-station sidecar. Point it at the directory where your ground software already
// writes received products (for example HDTN BpReceiveFile or ION bpcp output) and at
// your pass schedule; it writes a signed ledger. Nothing is sent anywhere.
//
//   node ground/station.mjs --in <dir> --passes <passes.json> --station <eid> \
//        --spacecraft <eid> --key <station-key.json> --out <ledger.json>
//
// Reception time is the file's modification time unless the pass file supplies
// "received": { "<name>": <epoch ms or ISO> } (use this when your software logs it).
// The key file is created on first run; keep it private and pin its "pub" in verifiers.
import { readFileSync, writeFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { genKeypair, exportKeypair, importKeypair } from "../agent/lib/keys.mjs";
import { buildLedger } from "./lib.mjs";

const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i > 0 ? process.argv[i + 1] : d; };
const need = (n) => arg(n) ?? (console.error(`missing --${n}`), process.exit(2));
const inDir = need("in"), passFile = need("passes"), station = need("station"), spacecraft = need("spacecraft"), keyFile = need("key");
const out = arg("out", "ledger.json");
const chunkSize = Number(arg("chunk", 65536));

let kp;
if (existsSync(keyFile)) kp = importKeypair(JSON.parse(readFileSync(keyFile, "utf8")));
else { kp = genKeypair(); writeFileSync(keyFile, JSON.stringify(exportKeypair(kp), null, 2), { mode: 0o600 }); console.log(`new station key written to ${keyFile}`); }

const sched = JSON.parse(readFileSync(passFile, "utf8"));
const receivedLog = sched.received || {};
const files = [];
(function walk(d) {
  for (const n of readdirSync(d)) {
    const p = join(d, n);
    const s = statSync(p);
    if (s.isDirectory()) { walk(p); continue; }
    const name = relative(inDir, p).split("\\").join("/");
    const logged = receivedLog[name];
    files.push({ name, bytes: readFileSync(p), receivedAt: logged !== undefined ? (typeof logged === "number" ? logged : Date.parse(logged)) : Math.round(s.mtimeMs) });
  }
})(inDir);

const ledger = buildLedger(kp, { station, spacecraft, files, passes: sched.passes, chunkSize });
writeFileSync(out, JSON.stringify(ledger, null, 2));
const passes = ledger.records.filter((r) => r.kind === "station.pass/1");
console.log(`${station}: ${files.length} products, ${passes.length} scheduled passes (${passes.filter((p) => p.status === "no-data").length} silent), ${ledger.records.length} records`);
console.log(`ledger ${out}  seal root ${ledger.seal.root}`);
console.log(`station public key (pin this): ${kp.pub}`);
