// M0 spike, LOCAL (no Docker): spawn the four node processes on localhost, run a real
// socket store-and-forward transport through a scripted occultation, and assert the
// destination reassembled + verified the payload. This proves the transport and the
// agent over a real wire; the Docker variant (make spike) adds kernel-level `tc netem`
// shaping and a real link teardown on top, same processes.
import { spawn } from "node:child_process";
import { writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { genKeypair, exportKeypair } from "../agent/lib/keys.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const nodeScript = join(here, "node.mjs");
const keysFile = join(here, ".keys.json");
const cfgFile = join(here, ".m0-config.json");

// Provision identities for all four nodes and pin them into a shared keys file.
const keys = {};
for (const r of ["source", "relaya", "relayb", "dest"]) keys[r] = exportKeypair(genKeypair());
mkdirSync(here, { recursive: true });
writeFileSync(keysFile, JSON.stringify(keys));

const cfg = {
  keysFile,
  eids: { source: "dtn://source/", relaya: "dtn://relaya/", relayb: "dtn://relayb/", dest: "dtn://dest/" },
  ports: { relaya: 5401, relayb: 5402, dest: 5403 },
  payloadId: "0xrover-frame-001",
  chunkSize: 64,
  // The occulted link is relaya -> relayb (L2). It starts DOWN and reopens at +1200ms,
  // so every bundle is held during the blackout and store-and-forwarded on reopen.
  // Local spike uses app-level hold (no real link to drop); the netem variant sets
  // appHold false and drops the veth for real.
  appHold: true,
  occultation: { relay: "relaya", link: "L2", downMs: 0, upMs: 1200 },
  settlementRef: "0x4e40b7bf86a0ca24f9746f3b6b5178def04b3a29024e4c7c9f8b95099ce380b8",
  payTo: "1LdqUbdZ6GY71KxThU6aKfuKXxgmTn82cv",
  amountAtomic: 5942,
};
writeFileSync(cfgFile, JSON.stringify(cfg, null, 2));

const procs = [];
function launch(role) {
  const p = spawn(process.execPath, [nodeScript], {
    env: { ...process.env, M0_ROLE: role, M0_CONFIG: cfgFile },
    stdio: ["ignore", "pipe", "inherit"],
  });
  p.role = role;
  procs.push(p);
  return p;
}

let result = null;
function cleanup() { for (const p of procs) { try { p.kill(); } catch {} } }

// Start downstream-first so connect-retry succeeds quickly.
const dest = launch("dest");
dest.stdout.on("data", (d) => {
  for (const line of d.toString().split("\n")) {
    if (line.startsWith("M0_RESULT ")) result = JSON.parse(line.slice("M0_RESULT ".length));
  }
});

setTimeout(() => launch("relayb"), 150);
setTimeout(() => launch("relaya"), 300);
setTimeout(() => launch("source"), 500);

dest.on("exit", (code) => {
  cleanup();
  console.log("\n=== M0 spike (local socket transport, scripted occultation) ===");
  if (!result) { console.log("no result captured; dest exit", code); process.exit(1); }
  const P = (b) => (b ? "PASS" : "FAIL");
  console.log(`  chunks delivered through blackout : ${result.chunks}`);
  console.log(`  payload complete + reassembled    : ${P(result.complete)} (${result.reassembledBytes} bytes)`);
  console.log(`  custody chain verified            : ${P(result.custodyChainOk)}`);
  console.log(`  gap object across occultation      : down@${result.gap?.downAt}ms up@${result.gap?.upAt}ms delayed ${result.gap?.delayed}`);
  console.log(`  delivery bound to settlement       : ${P(result.deliveryBound)}`);
  console.log(`  wall-clock elapsed                 : ${result.elapsedMs}ms (payload held ~1200ms by the blackout, then delivered)`);
  console.log(`  OVERALL                            : ${P(result.ok)}`);
  process.exit(result.ok ? 0 : 1);
});

// Safety timeout.
setTimeout(() => { cleanup(); console.error("M0 spike timed out"); process.exit(2); }, 15000);
