#!/usr/bin/env bash
# Container entrypoint for the netem M0 spike. Builds the shaped 4-namespace chain,
# provisions node keys, launches the four node processes in their namespaces, drives a
# REAL occultation on L2, and reports the destination's verdict. Run via `make spike`
# (docker build + docker run --privileged). Mirrors m0/run-local.mjs, but over real
# veths with `tc netem`.
set -euo pipefail
cd /app

bash m0/net-setup.sh

# Provision keys (same shape run-local writes) into m0/.keys.json.
node -e '
  const { genKeypair, exportKeypair } = await import("./agent/lib/keys.mjs");
  const fs = await import("node:fs");
  const k = {}; for (const r of ["source","relaya","relayb","dest"]) k[r] = exportKeypair(genKeypair());
  fs.writeFileSync("m0/.keys.json", JSON.stringify(k));
' --input-type=module 2>/dev/null || node --input-type=module -e '
  import { genKeypair, exportKeypair } from "./agent/lib/keys.mjs";
  import fs from "node:fs";
  const k = {}; for (const r of ["source","relaya","relayb","dest"]) k[r] = exportKeypair(genKeypair());
  fs.writeFileSync("m0/.keys.json", JSON.stringify(k));
'

CFG=m0/config.docker.json
run() { ip netns exec "$1" env M0_ROLE="$2" M0_CONFIG="$CFG" node m0/node.mjs; }

# Downstream-first.
run n_dst dest &  DEST_PID=$!
sleep 0.3
run n_b   relayb & B_PID=$!
sleep 0.2
run n_a   relaya & A_PID=$!
sleep 0.2
# Drive the real occultation in the background, then start the source.
DOWN_AT_MS=800 WINDOW_MS=3000 bash m0/occult.sh &
run n_src source & S_PID=$!

# Wait for the destination to render its verdict (it exits 0 on PASS).
set +e
wait "$DEST_PID"; CODE=$?
set -e
kill "$B_PID" "$A_PID" "$S_PID" 2>/dev/null || true
echo "=== M0 netem spike exit: $CODE (0 = payload survived a REAL L2 blackout and verified) ==="
exit "$CODE"
