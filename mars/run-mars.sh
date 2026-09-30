#!/usr/bin/env bash
# Our custody payload across a Mars-distance link. Two JPL ION nodes, each in its own
# network and IPC namespace, joined by a veth pair that netem delays 240 s each way. The
# convergence layer is LTP over UDP, ION's protocol for long light times; ranges in the
# compiled contact plan tell LTP the 240 s one-way light time so its timers match.
set -uo pipefail
cd /app
OWLT=${OWLT:-240}
node contact-plans/compile.mjs mars/interop.json --ion /tmp/contacts.ionrc
# The planned light time must match the emulated one (LTP sizes its timers from it).
sed -i "s/^\(a range .*\) 240$/\1 ${OWLT}/" /tmp/contacts.ionrc
echo "[mars] ION $(cat /opt/ion/COMMIT); one-way light time ${OWLT} s; contact plan:"
grep '^a ' /tmp/contacts.ionrc | sed 's/^/        /'

ip netns add m1; ip netns add m2
ip link add v1 type veth peer name v2
ip link set v1 netns m1; ip link set v2 netns m2
ip -n m1 addr add 10.9.0.1/24 dev v1; ip -n m2 addr add 10.9.0.2/24 dev v2
ip -n m1 link set v1 up; ip -n m2 link set v2 up; ip -n m1 link set lo up; ip -n m2 link set lo up
# Pin each side's neighbour address. Otherwise the kernel's ARP request is itself delayed by
# the light time, resolution gives up after a few seconds, and every packet is dropped. A
# real deep-space link has no ARP; this removes an artefact of emulating one on Ethernet.
M1=$(ip -n m1 -br link show v1 | awk '{print $3}'); M2=$(ip -n m2 -br link show v2 | awk '{print $3}')
ip -n m1 neigh replace 10.9.0.2 lladdr "$M2" dev v1 nud permanent
ip -n m2 neigh replace 10.9.0.1 lladdr "$M1" dev v2 nud permanent
for n in 1 2; do ip netns exec m$n tc qdisc add dev v$n root netem delay ${OWLT}s limit 100000; done
ip netns exec m1 tc qdisc show dev v1 | sed 's/^/        /'

node ion/prepare.mjs
N=$(node -e 'console.log(JSON.parse(require("fs").readFileSync("/tmp/pins.json","utf8")).chunks + 1)')

mk_node() { # node peer
  local n=$1 p=$2 d=/tmp/n$1
  mkdir -p "$d/recv"
  printf 'configFlags 1\nwmSize 5000000\nheapWords 2500000\npathName %s\n' "$d" > "$d/node.ionconfig"
  {
    echo "## begin ionadmin"; echo "1 $n $d/node.ionconfig"; echo "s"
    grep '^a ' /tmp/contacts.ionrc
    echo "a contact +0 +7200 $n $n 125000"; echo "a range +0 +7200 $n $n 0"
    echo "m horizon +0"; echo "## end ionadmin"
    # ION needs its security database initialized even with no BPSec rules; without it
    # bundles are handed to LTP but never transmitted.
    echo "## begin ionsecadmin"; echo "1"; echo "## end ionsecadmin"
    echo "## begin ltpadmin"; echo "1 64"
    echo "a span $p 64 64 1400 10000 1 'udplso 10.9.0.$p:1113'"
    echo "s 'udplsi 10.9.0.$n:1113'"; echo "## end ltpadmin"
    echo "## begin bpadmin"; echo "1"
    echo "a scheme ipn 'ipnfw' 'ipnadminep'"
    echo "a endpoint ipn:$n.1 q"; echo "a endpoint ipn:$n.2 q"
    echo "a protocol ltp 1400 100"
    echo "a induct ltp $n ltpcli"; echo "a outduct ltp $p ltpclo"
    echo "s"; echo "## end bpadmin"
    echo "## begin ipnadmin"; echo "a plan $p ltp/$p"; echo "## end ipnadmin"
  } > "$d/node.rc"
}
mk_node 1 2
mk_node 2 1

ip netns exec m2 unshare --ipc --mount --fork bash -c "mount -t tmpfs tmpfs /dev/shm && cd /tmp/n2 && ionstart -I node.rc >/tmp/n2/start.log 2>&1 && cd recv && timeout $((OWLT * 3 + 240)) bprecvfile ipn:2.1 $N >/tmp/n2/recv.log 2>&1; cd /tmp/n2 && ionstop >/dev/null 2>&1" & R=$!
ip netns exec m1 unshare --ipc --mount --fork bash -c "
  mount -t tmpfs tmpfs /dev/shm && cd /tmp/n1 && ionstart -I node.rc >/tmp/n1/start.log 2>&1
  sleep 5; date +%s%3N > /tmp/tsend
  for f in /tmp/send/*; do bpsendfile ipn:1.2 ipn:2.1 \"\$f\" 1 7200 >>/tmp/n1/send.log 2>&1; done
  echo \"[mars] node 1 handed ION \$(ls /tmp/send | wc -l) files at \$(date -u +%H:%M:%S) UTC; waiting out the light time\"
  sleep $((OWLT * 2 + 60)); ionstop >/dev/null 2>&1" & S=$!
wait "$R"
echo "[mars] received files: $(find /tmp/n2/recv -type f | wc -l) (at $(date -u +%H:%M:%S) UTC)"
OWLT=$OWLT node mars/verify.mjs; CODE=$?
if [ "$CODE" != "0" ]; then for f in /tmp/n1/start.log /tmp/n1/send.log /tmp/n1/ion.log /tmp/n2/recv.log /tmp/n2/ion.log; do echo "--- $f (tail)"; tail -12 "$f" 2>/dev/null; done; fi
kill $S 2>/dev/null
echo "=== MARS exit: $CODE ==="
exit "$CODE"
