#!/usr/bin/env bash
# R2: our custody agent over REAL BPv7 (µD3TN). Four nodes chained by mtcp CLAs. The
# relaya->relayb contact opens LATE, so µD3TN holds the bundles in its own storage
# during the gap and forwards on contact = real bundle custody store-and-forward
# (M0's store-and-forward was TCP retransmit; this is application-independent DTN
# custody). The destination reassembles + verifies + checks the custody chain +
# binds the settlement, exactly as offline.
set -uo pipefail
cd /app
UD=/opt/ud3tn/build/posix/ud3tn
CFG="python3 /opt/ud3tn/tools/aap/aap_config.py"

# node ids, aap ports, mtcp CLA ports
start_node() { # eid aap_port cla_port logfile
  # distinct in-memory DB name per node so parallel processes never alias the store
  $UD -L 1 -e "$1" -a 127.0.0.1 -p "$2" -c "sqlite:file:db$2?mode=memory&cache=shared;mtcp:*,$3" >"$4" 2>&1 &
  sleep 0.5
}
start_node "dtn://source.dtn/" 4241 4251 /tmp/n_src.log
start_node "dtn://relaya.dtn/" 4242 4252 /tmp/n_a.log
start_node "dtn://relayb.dtn/" 4243 4253 /tmp/n_b.log
start_node "dtn://dest.dtn/"   4244 4254 /tmp/n_dst.log
sleep 1
for f in /tmp/n_src.log /tmp/n_a.log /tmp/n_b.log /tmp/n_dst.log; do grep -qiE "abort|assert|fatal|error" "$f" && { echo "NODE FAILED ($f):"; tail -4 "$f"; }; done || true

# contacts (start_offset seconds, duration, bitrate). relaya->relayb opens at +6s: the
# gap during which relaya's uD3TN holds the bundles.
$CFG --tcp 127.0.0.1 4241 --schedule 1 3600 100000 dtn://relaya.dtn/ mtcp:127.0.0.1:4252 >/dev/null 2>&1
$CFG --tcp 127.0.0.1 4242 --schedule 6 3600 100000 dtn://relayb.dtn/ mtcp:127.0.0.1:4253 >/dev/null 2>&1
$CFG --tcp 127.0.0.1 4243 --schedule 1 3600 100000 dtn://dest.dtn/   mtcp:127.0.0.1:4254 >/dev/null 2>&1
echo "[r2] contacts configured; relaya->relayb opens at +6s (the custody hold window)"

# provision keys
node --input-type=module -e '
  import { genKeypair, exportKeypair } from "./agent/lib/keys.mjs";
  import fs from "node:fs";
  const k = {}; for (const r of ["source","relaya","relayb","dest"]) k[r] = exportKeypair(genKeypair());
  fs.writeFileSync("/tmp/keys.json", JSON.stringify(k));
'
export KEYS_FILE=/tmp/keys.json PAYLOAD_ID=0xrover-frame-001 CHUNK_SIZE=64 PAYLOAD_REPEAT=20 \
       SETTLEMENT_REF=0x4e40b7bf86a0ca24f9746f3b6b5178def04b3a29024e4c7c9f8b95099ce380b8 \
       PAY_TO=1LdqUbdZ6GY71KxThU6aKfuKXxgmTn82cv AMOUNT=5942 OCC_DOWN_MS=0 OCC_UP_MS=6000 \
       HOP_A_EID=dtn://relaya.dtn/ HOP_B_EID=dtn://relayb.dtn/

# agents: receivers first (register), then the source
ROLE=dest   AAP_PORT=4244 node /app/r2/agent-node.mjs & DEST=$!
ROLE=relayb AAP_PORT=4243 ROLEKEY=relayb NODE_EID=dtn://relayb.dtn/ PREV_EID=dtn://relaya.dtn/ NEXT_EID=dtn://dest.dtn/app  node /app/r2/agent-node.mjs & B=$!
ROLE=relaya AAP_PORT=4242 ROLEKEY=relaya NODE_EID=dtn://relaya.dtn/ PREV_EID=dtn://source.dtn/ NEXT_EID=dtn://relayb.dtn/app node /app/r2/agent-node.mjs & A=$!
sleep 1
ROLE=source AAP_PORT=4241 NEXT_EID=dtn://relaya.dtn/app node /app/r2/agent-node.mjs & S=$!

# wait for the destination verdict
wait "$DEST"; CODE=$?
kill "$B" "$A" "$S" 2>/dev/null || true
echo "=== R2 exit: $CODE (0 = payload carried over real µD3TN BPv7 + custody, held across a contact gap, verified) ==="
exit "$CODE"
