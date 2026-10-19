#!/usr/bin/env bash
# One relief node: µD3TN plus the relief daemon for NODE_NAME, using /deploy/<NODE_NAME>.json.
#   CONTACTS   space-separated "<peer eid>@<host>:<port>@<start seconds>" (outgoing links)
#   DEMO_FILE  optional: a file copied into this clinic's outbox once the node is up
# With NODE_NAME=provision it creates the deployment in /deploy instead (once; never overwrites).
set -euo pipefail
cd /app
if [ "${NODE_NAME:-}" = provision ]; then
  if [ -f /deploy/directory.json ]; then echo "[provision] /deploy already provisioned; keeping its keys"; exit 0; fi
  node relief/kit/provision.mjs "${DEPLOYMENT:-relief/kit/docker/deployment.json}" --out /deploy
  exit 0
fi
CFG=/deploy/$NODE_NAME.json
EID=$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1])).eid)' "$CFG")
/opt/ud3tn/build/posix/ud3tn -L 2 -e "$EID" -a 127.0.0.1 -p 4242 -c "sqlite:file:/data/bundles.sqlite;tcpclv3:*,4224" &
for i in $(seq 1 50); do (exec 3<>/dev/tcp/127.0.0.1/4242) 2>/dev/null && break; sleep 0.2; done
for c in ${CONTACTS:-}; do
  IFS=@ read -r peer addr start <<<"$c"
  python3 /opt/ud3tn/tools/aap/aap_config.py --tcp 127.0.0.1 4242 --schedule "$start" 864000 512000 "$peer" "tcpclv3:$addr" 2>/dev/null
  echo "[$NODE_NAME] contact to $peer via $addr opens in ${start}s"
done
if [ -n "${DEMO_FILE:-}" ]; then
  ( sleep 8; mkdir -p /data/outbox; cp "$DEMO_FILE" "/data/outbox/$(basename "$DEMO_FILE")"; echo "[$NODE_NAME] demo: dropped $(basename "$DEMO_FILE") into the outbox" ) &
fi
exec node relief/kit/node.mjs --config "$CFG" --data /data
