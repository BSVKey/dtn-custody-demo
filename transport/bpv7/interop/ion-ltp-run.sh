#!/usr/bin/env bash
# Live: the Custody Receipt Block (receipt version 2) and a payload BIB across an LTP
# convergence layer, the long-haul option LunaNet names (LNIS v5 section 3.1.2), with the
# Earth-Moon light time on the link. Neither ION node knows block 224.
#
#   our gateway (ipn:1) --UDP--> ION ipn:10 --LTP over UDP, netem 1282 ms each way--> ION ipn:20 --UDP--> our destination (ipn:2)
#
# Each ION node runs in its own network and IPC namespace, joined by a veth pair. The
# gateway stamps receipt 1 and hands the raw bundle to ION ipn:10; the destination checks
# block 224 arrived byte-identical, verifies the BIB, stamps receipt 2 and verifies the chain.
# Run (repo mounted at /app, image with ION and iproute2, for example dtn-custody-mars):
#   docker run --rm --privileged --entrypoint bash -v "$PWD:/app" dtn-custody-mars /app/transport/bpv7/interop/ion-ltp-run.sh
set -uo pipefail
cd /app
OWLT_MS=${OWLT_MS:-1282}

ip netns add l1; ip netns add l2
ip link add v1 type veth peer name v2
ip link set v1 netns l1; ip link set v2 netns l2
ip -n l1 addr add 10.8.0.1/24 dev v1; ip -n l2 addr add 10.8.0.2/24 dev v2
for n in 1 2; do ip -n l$n link set v$n up; ip -n l$n link set lo up; done
# Pinned neighbours: on a delayed veth, ARP itself would wait out the light time.
M1=$(ip -n l1 -br link show v1 | awk '{print $3}'); M2=$(ip -n l2 -br link show v2 | awk '{print $3}')
ip -n l1 neigh replace 10.8.0.2 lladdr "$M2" dev v1 nud permanent
ip -n l2 neigh replace 10.8.0.1 lladdr "$M1" dev v2 nud permanent
for n in 1 2; do ip netns exec l$n tc qdisc add dev v$n root netem delay ${OWLT_MS}ms limit 100000; done
echo "[ltp] link ipn:10 <-> ipn:20: LTP over UDP, netem $(ip netns exec l1 tc qdisc show dev v1 | grep -o 'delay [0-9.]*s') each way"

mk_node() { # node peer peer_addr
  local n=$1 p=$2 pa=$3 d=/tmp/n$1
  mkdir -p "$d"
  printf 'configFlags 1\nwmSize 5000000\nheapWords 2500000\npathName %s\n' "$d" > "$d/node.ionconfig"
  {
    echo "## begin ionadmin"; echo "1 $n $d/node.ionconfig"; echo "s"
    echo "a contact +0 +3600 $n $n 12500000"; echo "a range +0 +3600 $n $n 0"
    echo "a contact +0 +3600 10 20 125000"; echo "a range +0 +3600 10 20 2"
    echo "a contact +0 +3600 20 10 125000"; echo "a range +0 +3600 20 10 2"
    echo "a contact +0 +3600 10 2 125000"; echo "a range +0 +3600 10 2 2"
    echo "a contact +0 +3600 20 2 12500000"; echo "a range +0 +3600 20 2 0"
    echo "m horizon +0"; echo "## end ionadmin"
    echo "## begin ionsecadmin"; echo "1"; echo "## end ionsecadmin"
    echo "## begin ltpadmin"; echo "1 64"
    echo "a span $p 64 64 1400 10000 1 'udplso $pa:1113'"
    echo "s 'udplsi 0.0.0.0:1113'"; echo "## end ltpadmin"
    echo "## begin bpadmin"; echo "1"
    echo "a scheme ipn 'ipnfw' 'ipnadminep'"
    echo "a endpoint ipn:$n.1 q"
    echo "a protocol ltp 1400 100"; echo "a protocol udp"
    echo "a induct ltp $n ltpcli"; echo "a outduct ltp $p ltpclo"
    [ "$n" = 10 ] && echo "a induct udp 127.0.0.1:4556 udpcli"
    [ "$n" = 20 ] && echo "a outduct udp 127.0.0.1:4558 udpclo"
    echo "s"; echo "## end bpadmin"
    echo "## begin ipnadmin"
    [ "$n" = 10 ] && echo "a plan 2 ltp/20" && echo "a plan 20 ltp/20"
    [ "$n" = 20 ] && echo "a plan 2 udp/127.0.0.1:4558" && echo "a plan 10 ltp/10"
    echo "## end ipnadmin"
  } > "$d/node.rc"
}
mk_node 10 20 10.8.0.2
mk_node 20 10 10.8.0.1

export BUNDLE_SRC=ipn:1.1 BUNDLE_DST=ipn:2.1 RECEIPT=2 BPSEC=1 VIA="two unaware JPL ION nodes over LTP with Earth-Moon light time"
ip netns exec l2 node transport/bpv7/interop/cl.mjs recv udp 4558 /tmp/out.hex 90 & RECV=$!
ip netns exec l2 unshare --ipc --mount --fork bash -c "mount -t tmpfs tmpfs /dev/shm && cd /tmp/n20 && ionstart -I node.rc >/tmp/n20/start.log 2>&1 && sleep 100; ionstop >/dev/null 2>&1" & I2=$!
ip netns exec l1 unshare --ipc --mount --fork bash -c "mount -t tmpfs tmpfs /dev/shm && cd /tmp/n10 && ionstart -I node.rc >/tmp/n10/start.log 2>&1 && sleep 100; ionstop >/dev/null 2>&1" & I1=$!
echo "[ltp] ION $(cat /opt/ion/COMMIT) nodes ipn:10 and ipn:20"
sleep 8
node transport/bpv7/interop/live.mjs make /tmp/in.hex
T0=$(date +%s%3N)
ip netns exec l1 node transport/bpv7/interop/cl.mjs send udp 4556 /tmp/in.hex
wait "$RECV"; RC=$?
T1=$(date +%s%3N)
echo "[ltp] delivered $(( T1 - T0 )) ms after hand-off (one LTP crossing needs at least ${OWLT_MS} ms)"
CODE=1
if [ "$RC" = 0 ]; then
  node transport/bpv7/interop/live.mjs check /tmp/in.hex /tmp/out.hex; CODE=$?
  [ "$CODE" = 0 ] && [ $(( T1 - T0 )) -lt "$OWLT_MS" ] && { echo "[ltp] FAIL: arrived faster than the light time"; CODE=1; }
fi
[ "$CODE" != 0 ] && for f in /tmp/n10/ion.log /tmp/n20/ion.log /tmp/n10/start.log /tmp/n20/start.log; do echo "--- $f (tail)"; tail -15 "$f" 2>/dev/null; done
kill "$I1" "$I2" 2>/dev/null
echo "=== bpv7-block-ion-ltp exit: $CODE (0 = block 224 v2 and the BIB carried intact over LTP with light time, chain verified) ==="
exit "$CODE"
