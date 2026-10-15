#!/usr/bin/env bash
# Live: does a real BPv7 stack that has never heard of the Custody Receipt Block keep it?
# Our gateway agent stamps hop 1 and hands the bundle to uD3TN relaya over MTCP. relaya
# forwards to uD3TN relayb, which HOLDS it until its contact to the destination opens
# (+6 s), then delivers over MTCP to our destination agent. That agent checks the block
# arrived byte-identical, stamps hop 2 and verifies the chain against its pinned keys.
# Run: make bpv7-block  (docker image dtn-custody-r2, repo mounted at /app)
set -euo pipefail
cd /app/transport/bpv7/interop
UD=/opt/ud3tn/build/posix/ud3tn
CFG="python3 /opt/ud3tn/tools/aap/aap_config.py"
W=$(mktemp -d)

# One distinct in-memory store per node, started one at a time (as in r2/run-r2.sh).
start_node() { # eid aap_port cla_port
  (cd "$W" && exec $UD -L 1 -e "$1" -a 127.0.0.1 -p "$2" -c "sqlite:file:db$2?mode=memory&cache=shared;mtcp:*,$3" >"$W/$2.log" 2>&1) &  # sockets go in $W, not the repo
  sleep 0.5
}
start_node dtn://relaya.dtn/ 4241 4251
start_node dtn://relayb.dtn/ 4242 4252
sleep 1
python3 mtcp.py recv 4254 "$W/out.hex" 25 & RECV=$!
$CFG --tcp 127.0.0.1 4241 --schedule 1 3600 100000 --reaches dtn://dest.dtn/ dtn://relayb.dtn/ mtcp:127.0.0.1:4252 >/dev/null
$CFG --tcp 127.0.0.1 4242 --schedule 6 3600 100000 dtn://dest.dtn/ mtcp:127.0.0.1:4254 >/dev/null
echo "[live] contacts: relaya->relayb at +1 s, relayb->dest at +6 s (relayb holds the bundle meanwhile)"

node live.mjs make "$W/in.hex"
python3 mtcp.py send 4251 "$W/in.hex"
T0=$(date +%s)
wait "$RECV"
echo "[live] delivered after $(( $(date +%s) - T0 )) s"
set +e
node live.mjs check "$W/in.hex" "$W/out.hex"; CODE=$?
echo "=== bpv7-block exit: $CODE (0 = custody block carried intact by unaware uD3TN nodes, chain verified) ==="
exit "$CODE"
