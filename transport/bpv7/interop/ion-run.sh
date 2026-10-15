#!/usr/bin/env bash
# Live: the Custody Receipt Block through JPL ION, which does not know block 224 (and uses 192 to 197 for its own blocks).
# Our gateway agent stamps hop 1 and hands the raw bundle to ION node ipn:10 over ION's
# UDP convergence layer. ION's contact to the destination (ipn:2) opens only at +20 s, so
# contact graph routing must hold the bundle, then udpclo sends it to our destination
# agent, which checks the block arrived byte-identical, stamps hop 2 and verifies.
# Run: make bpv7-block-ion  (docker image dtn-custody-ion, --privileged, repo at /app)
set -uo pipefail
cd /app
D=/tmp/n10; mkdir -p "$D"
printf 'configFlags 1\nwmSize 5000000\nheapWords 2500000\npathName %s\n' "$D" > "$D/node.ionconfig"
cat > "$D/node.rc" <<R
## begin ionadmin
1 10 $D/node.ionconfig
s
a contact +0 +3600 10 10 12500000
a range +0 +3600 10 10 0
a contact +20 +3600 10 2 12500000
a range +0 +3600 10 2 1
m horizon +0
## end ionadmin
## begin bpadmin
1
a scheme ipn 'ipnfw' 'ipnadminep'
a endpoint ipn:10.1 q
a protocol udp
a induct udp 127.0.0.1:4556 udpcli
a outduct udp 127.0.0.1:4558 udpclo
s
## end bpadmin
## begin ipnadmin
a plan 2 udp/127.0.0.1:4558
## end ipnadmin
R
export BUNDLE_SRC=ipn:1.1 BUNDLE_DST=ipn:2.1 VIA="unaware JPL ION (held by contact graph routing)"
node transport/bpv7/interop/cl.mjs recv udp 4558 /tmp/out.hex 60 & RECV=$!
unshare --ipc --mount --fork bash -c "mount -t tmpfs tmpfs /dev/shm && cd $D && ionstart -I node.rc >$D/start.log 2>&1 && sleep 75; ionstop >/dev/null 2>&1" & ION=$!
T0=$(date +%s)
echo "[ion] ION $(cat /opt/ion/COMMIT) node ipn:10; contact 10->2 opens at +20 s"
sleep 6
node transport/bpv7/interop/live.mjs make /tmp/in.hex
node transport/bpv7/interop/cl.mjs send udp 4556 /tmp/in.hex
echo "[ion] sent at +$(( $(date +%s) - T0 )) s"
wait "$RECV"; RC=$?
echo "[ion] delivered at +$(( $(date +%s) - T0 )) s"
CODE=1
[ "$RC" = 0 ] && { node transport/bpv7/interop/live.mjs check /tmp/in.hex /tmp/out.hex; CODE=$?; }
[ "$CODE" != 0 ] && { echo "--- ion.log (tail)"; tail -20 "$D/ion.log" 2>/dev/null; tail -5 "$D/start.log"; }
kill "$ION" 2>/dev/null
echo "=== bpv7-block-ion exit: $CODE (0 = custody block carried intact by JPL ION, chain verified) ==="
exit "$CODE"
