#!/usr/bin/env bash
# LTP stress for NASA HDTN: bpsendfile (LTP outduct) to bpreceivefile (LTP induct), two
# network namespaces joined by a veth pair that netem delays, drops and corrupts. Each case
# sends one file of random bytes and passes when the received file's SHA-256 matches.
# The same sweep found ION's first-segment bug (voyager/ION-RESULTS.md).
#
#   CASES="mtu,bytes,delay_ms,loss_pct,corrupt_pct[,checkpoint_every] ..."   or SWEEP=full (make hdtn-ltp-sweep)
#
# mtu is HDTN's ltpDataSegmentMtu; a file is one bundle and one LTP block (4 MB bundle limit).
set -uo pipefail
A=/opt/HDTN/build/common/bpcodec/apps
if [ "${SWEEP:-}" = full ] && [ -z "${CASES:-}" ]; then   # the sweep in hdtn/LTP-RESULTS.md
  CASES=""
  for m in 64 200 550 1000 1360 8000 60000; do for b in 100 1500 20000 300000 3000000; do CASES="$CASES $m,$b,1,0,0"; done; done
  for m in 200 1360 8000; do for b in 1500 300000; do for i in 1,5,0 1,20,0 1,0,1 300,5,0 2000,10,0; do CASES="$CASES $m,$b,$i"; done; done; done
  CASES="$CASES 64,0,1,0,0 64,1,1,0,0 64,63,1,0,0 64,64,1,0,0 64,65,1,0,0 30,1500,1,0,0 30,20000,1,5,0"
  CASES="$CASES 1360,300000,1,0,0,10 200,300000,1,10,0,10 1360,300000,1,40,0 1360,1500,1,40,0"
fi
CASES=${CASES:-"1360,1500,1,0,0 1360,20000,1,0,0"}
CASE_TIMEOUT_S=${CASE_TIMEOUT_S:-60}
echo "[hdtn-ltp] HDTN $(cat /opt/HDTN/COMMIT); case timeout ${CASE_TIMEOUT_S} s"

ip netns add h1; ip netns add h2
ip link add w1 type veth peer name w2
ip link set w1 netns h1; ip link set w2 netns h2
ip -n h1 addr add 10.8.0.1/24 dev w1; ip -n h2 addr add 10.8.0.2/24 dev w2
for n in h1 h2; do ip -n $n link set lo up; done
ip -n h1 link set w1 up; ip -n h2 link set w2 up
# Pinned neighbours: with loss on the link, ARP itself would be dropped (see mars/run-mars.sh).
M1=$(ip -n h1 -br link show w1 | awk '{print $3}'); M2=$(ip -n h2 -br link show w2 | awk '{print $3}')
ip -n h1 neigh replace 10.8.0.2 lladdr "$M2" dev w1 nud permanent
ip -n h2 neigh replace 10.8.0.1 lladdr "$M1" dev w2 nud permanent

configs() { # mtu delay_ms checkpoint_every
  python3 - "$@" <<'EOF'
import json, sys
mtu, delay, ckpt = int(sys.argv[1]), int(sys.argv[2]), int(sys.argv[3])
common = {"oneWayLightTimeMs": max(delay, 1), "oneWayMarginTimeMs": 200, "clientServiceId": 1,
          "numRxCircularBufferElements": 1000, "ltpMaxRetriesPerSerialNumber": 5, "ltpRandomNumberSizeBits": 64,
          "ltpMaxUdpPacketsToSendPerSystemCall": 1, "keepActiveSessionDataOnDisk": False,
          "activeSessionDataOnDiskNewFileDurationMs": 2000, "activeSessionDataOnDiskDirectory": "./"}
out = {"outductConfigName": "sweep", "outductVector": [dict(common, name="o1", convergenceLayer="ltp_over_udp",
       nextHopNodeId=2, remoteHostname="10.8.0.2", remotePort=4558, maxNumberOfBundlesInPipeline=5,
       maxSumOfBundleBytesInPipeline=50000000, thisLtpEngineId=200, remoteLtpEngineId=100, ltpDataSegmentMtu=mtu,
       ltpCheckpointEveryNthDataSegment=ckpt, ltpSenderBoundPort=1113, ltpSenderPingSecondsOrZeroToDisable=0,
       delaySendingOfDataSegmentsTimeMsOrZeroToDisable=20)]}
ind = {"inductConfigName": "sweep", "inductVector": [dict(common, name="i1", convergenceLayer="ltp_over_udp",
       boundPort=4558, thisLtpEngineId=100, remoteLtpEngineId=200, ltpReportSegmentMtu=1000,
       preallocatedRedDataBytes=200000, ltpRemoteUdpHostname="10.8.0.1", ltpRemoteUdpPort=1113,
       ltpRxDataSegmentSessionNumberRecreationPreventerHistorySize=1000, ltpMaxExpectedSimultaneousSessions=500,
       delaySendingOfReportSegmentsTimeMsOrZeroToDisable=20)]}
json.dump(out, open("/tmp/out.json", "w"), indent=1); json.dump(ind, open("/tmp/in.json", "w"), indent=1)
EOF
}

pass=0; fail=0; i=0
for c in $CASES; do
  i=$((i + 1)); IFS=, read -r mtu bytes delay loss corrupt ckpt <<< "$c"; ckpt=${ckpt:-0}
  for n in h1:w1 h2:w2; do
    ip netns exec ${n%%:*} tc qdisc replace dev ${n#*:} root netem delay ${delay}ms loss ${loss}% corrupt ${corrupt}% limit 100000
  done
  configs "$mtu" "$delay" "$ckpt"
  rm -rf /tmp/send /tmp/recv; mkdir -p /tmp/send /tmp/recv
  head -c "$bytes" /dev/urandom > /tmp/send/f.bin; want=$(sha256sum < /tmp/send/f.bin | cut -c1-64)
  ip netns exec h2 "$A/bpreceivefile" --my-uri-eid=ipn:2.1 --save-directory=/tmp/recv --inducts-config-file=/tmp/in.json >/tmp/recv.$i.log 2>&1 & R=$!
  sleep 1
  t0=$(date +%s%3N)
  ip netns exec h1 "$A/bpsendfile" --use-bp-version-7 --force-disable-custody --my-uri-eid=ipn:1.1 --dest-uri-eid=ipn:2.1 \
    --file-or-folder-path=/tmp/send --outducts-config-file=/tmp/out.json >/tmp/send.$i.log 2>&1 & S=$!
  got=""; t=""
  while [ $(( ($(date +%s%3N) - t0) / 1000 )) -lt "$CASE_TIMEOUT_S" ]; do
    f=$(find /tmp/recv -type f -name 'f.bin' 2>/dev/null | head -1)
    if [ -n "$f" ] && [ "$(stat -c %s "$f")" = "$bytes" ] && [ "$(sha256sum < "$f" | cut -c1-64)" = "$want" ]; then
      got=ok; t=$(( $(date +%s%3N) - t0 )); break
    fi
    sleep 0.2
  done
  kill -INT $S $R 2>/dev/null; sleep 0.5; kill -9 $S $R 2>/dev/null; wait $S $R 2>/dev/null
  label="mtu=$mtu bytes=$bytes delay=${delay}ms loss=$loss% corrupt=$corrupt%${ckpt:+ ckpt=$ckpt}"
  if [ "$got" = ok ]; then pass=$((pass + 1)); echo "CASE PASS $label in $(awk "BEGIN{printf \"%.1f\", $t/1000}") s"
  else
    fail=$((fail + 1)); f=$(find /tmp/recv -type f | head -1)
    echo "CASE FAIL $label: $( [ -n "$f" ] && echo "received $(stat -c %s "$f") bytes, hash differs or short" || echo "nothing received in ${CASE_TIMEOUT_S} s")"
    grep -i -E "error|warn" /tmp/send.$i.log /tmp/recv.$i.log | grep -v -i "bpsec" | sort | uniq -c | sort -rn | head -4 | sed 's/^/      /'
  fi
done
echo "=== HDTN LTP sweep: $pass passed, $fail failed ==="
[ "$fail" = 0 ]
