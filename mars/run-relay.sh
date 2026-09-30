#!/usr/bin/env bash
# Mars relay: rover (ipn:3) -> relay orbiter (ipn:1) -> Earth (ipn:2), three JPL ION nodes over
# LTP, each in its own network namespace, IPC namespace and /dev/shm. Rover to orbiter is a
# short link (10 ms); orbiter to Earth is delayed OWLT seconds each way with LOSS percent
# packet loss in both directions, and its contact only opens 120 s after start, so the
# orbiter must hold the rover's data until Earth is in view, then LTP must repair the losses
# across the light time. Our custody records are checked at Earth.
set -uo pipefail
cd /app
OWLT=${OWLT:-240}; LOSS=${LOSS:-5}
node contact-plans/compile.mjs mars/relay.json --ion /tmp/contacts.ionrc
sed -i -e "s/^\(a range .* 1 2\) 240$/\1 ${OWLT}/" -e "s/^\(a range .* 2 1\) 240$/\1 ${OWLT}/" /tmp/contacts.ionrc
echo "[relay] ION $(cat /opt/ion/COMMIT); orbiter-Earth light time ${OWLT} s, loss ${LOSS}% each way; contact plan:"
grep '^a ' /tmp/contacts.ionrc | sed 's/^/        /'

# Namespaces: r (rover) --vr/vo1-- o (orbiter) --vo2/ve-- e (Earth)
for n in r o e; do ip netns add $n; ip -n $n link set lo up 2>/dev/null; done
ip link add vr type veth peer name vo1; ip link set vr netns r; ip link set vo1 netns o
ip link add vo2 type veth peer name ve; ip link set vo2 netns o; ip link set ve netns e
ip -n r addr add 10.8.0.3/24 dev vr; ip -n o addr add 10.8.0.1/24 dev vo1
ip -n o addr add 10.9.0.1/24 dev vo2; ip -n e addr add 10.9.0.2/24 dev ve
for x in "r vr" "o vo1" "o vo2" "e ve"; do set -- $x; ip -n $1 link set $2 up; done
mac() { ip -n $1 -br link show $2 | awk '{print $3}'; }
# Static neighbour entries: an ARP request delayed by the light time would never resolve.
ip -n r neigh replace 10.8.0.1 lladdr "$(mac o vo1)" dev vr nud permanent
ip -n o neigh replace 10.8.0.3 lladdr "$(mac r vr)" dev vo1 nud permanent
ip -n o neigh replace 10.9.0.2 lladdr "$(mac e ve)" dev vo2 nud permanent
ip -n e neigh replace 10.9.0.1 lladdr "$(mac o vo2)" dev ve nud permanent
ip netns exec r tc qdisc add dev vr root netem delay 10ms limit 100000
ip netns exec o tc qdisc add dev vo1 root netem delay 10ms limit 100000
ip netns exec o tc qdisc add dev vo2 root netem delay ${OWLT}s loss ${LOSS}% limit 100000
ip netns exec e tc qdisc add dev ve root netem delay ${OWLT}s loss ${LOSS}% limit 100000
ip netns exec o tc qdisc show dev vo2 | sed 's/^/        /'

SENDER_EID=ipn:3.2 node ion/prepare.mjs
N=$(node -e 'console.log(JSON.parse(require("fs").readFileSync("/tmp/pins.json","utf8")).chunks + 1)')

mk_node() { # node listen-addr "peer:addr ..."
  local n=$1 lsi=$2; shift 2; local d=/tmp/n$n
  mkdir -p "$d/recv"
  printf 'configFlags 1\nwmSize 5000000\nheapWords 2500000\npathName %s\n' "$d" > "$d/node.ionconfig"
  {
    echo "## begin ionadmin"; echo "1 $n $d/node.ionconfig"; echo "s"
    grep '^a ' /tmp/contacts.ionrc
    echo "a contact +0 +14400 $n $n 125000"; echo "a range +0 +14400 $n $n 0"
    echo "m horizon +0"; echo "## end ionadmin"
    echo "## begin ionsecadmin"; echo "1"; echo "## end ionsecadmin"
    echo "## begin ltpadmin"; echo "1 64"
    for pa in "$@"; do echo "a span ${pa%%:*} 64 64 1400 10000 1 'udplso ${pa#*:}:1113'"; done
    echo "s 'udplsi $lsi:1113'"; echo "## end ltpadmin"
    echo "## begin bpadmin"; echo "1"
    echo "a scheme ipn 'ipnfw' 'ipnadminep'"
    echo "a endpoint ipn:$n.1 q"; echo "a endpoint ipn:$n.2 q"
    echo "a protocol ltp 1400 100"; echo "a induct ltp $n ltpcli"
    for pa in "$@"; do echo "a outduct ltp ${pa%%:*} ltpclo"; done
    echo "s"; echo "## end bpadmin"
    echo "## begin ipnadmin"; for pa in "$@"; do echo "a plan ${pa%%:*} ltp/${pa%%:*}"; done; echo "## end ipnadmin"
  } > "$d/node.rc"
}
mk_node 3 10.8.0.3 1:10.8.0.1
mk_node 1 0.0.0.0 3:10.8.0.3 2:10.9.0.2
mk_node 2 10.9.0.2 1:10.9.0.1

run_in() { ip netns exec "$1" unshare --ipc --mount --fork bash -c "mount -t tmpfs tmpfs /dev/shm && $2"; }
run_in e "cd /tmp/n2 && ionstart -I node.rc >start.log 2>&1 && cd recv && timeout $((OWLT * 12 + 900)) bprecvfile ipn:2.1 $N >../recv.log 2>&1; cd /tmp/n2 && ionstop >/dev/null 2>&1" & R=$!
run_in o "cd /tmp/n1 && date +%s%3N > /tmp/t_orb && ionstart -I node.rc >start.log 2>&1 && sleep $((OWLT * 12 + 900))" & O=$!
run_in r "cd /tmp/n3 && ionstart -I node.rc >start.log 2>&1 && sleep 5 && date +%s%3N > /tmp/tsend && for f in /tmp/send/*; do bpsendfile ipn:3.2 ipn:2.1 \"\$f\" 0.1 14400 >>send.log 2>&1; done && echo \"[relay] rover handed ION \$(ls /tmp/send | wc -l) files at \$(date -u +%H:%M:%S) UTC; the orbiter holds them until Earth is in view at +120 s\" && sleep $((OWLT * 12 + 900))" & S=$!
wait "$R"
echo "[relay] received at Earth: $(find /tmp/n2/recv -type f | wc -l) files (at $(date -u +%H:%M:%S) UTC)"
for d in vo2 vo1; do echo "[relay] orbiter $d: $(ip netns exec o tc -s qdisc show dev $d | sed -n 2p | sed 's/^ *//')"; done
echo "[relay] Earth ve: $(ip netns exec e tc -s qdisc show dev ve | sed -n 2p | sed 's/^ *//')"
# Earliest possible arrival: the orbiter-Earth contact opens 120 s after the orbiter loads
# its plan, plus one light time; expressed relative to the rover's send time.
EARLIEST=$(( ($(cat /tmp/t_orb) + 120000 + OWLT * 1000 - $(cat /tmp/tsend)) / 1000 ))
echo "[relay] earliest physically possible arrival: ${EARLIEST} s after sending"
SENDER_EID=ipn:3.2 OWLT=$OWLT EARLIEST_S=$EARLIEST TRANSPORT="JPL ION LTP relay: rover ipn:3 -> orbiter ipn:1 -> Earth ipn:2; orbiter-Earth ${OWLT} s each way, ${LOSS}% loss each way" node mars/verify.mjs; CODE=$?
if [ "$CODE" != "0" ]; then for f in /tmp/n3/send.log /tmp/n1/ion.log /tmp/n2/recv.log /tmp/n2/ion.log; do echo "--- $f (tail)"; grep -v security "$f" 2>/dev/null | tail -10; done; fi
kill $S $O 2>/dev/null
echo "=== RELAY exit: $CODE ==="
exit "$CODE"
