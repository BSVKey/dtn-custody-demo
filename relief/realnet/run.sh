#!/usr/bin/env bash
# Relief scenario over a REAL network: five Linux network namespaces joined by veth links,
# each running its own µD3TN (BPv7 over TCPCLv3, which acknowledges every bundle, so a
# transfer cut by an outage is retried, not lost) and relief node daemon from relief/kit. Link conditions
# are real kernel traffic handling, not simulator time: tc netem where the kernel has it;
# otherwise iptables random drops for loss, a kernel tbf qdisc for rate and a TCP delay
# relay (delay-relay.mjs) for propagation delay. The blackout is real 100% packet loss.
#
#   clinic-north --+  Wi-Fi Direct: 5 ms, 0.5% loss
#   clinic-river --+-> courier-07 ---ride---> village-kalo ===GEO satellite===> district-hub
#                                  contact opens          280 ms +-20 ms, 1% loss, 512 kbit/s,
#                                  after RIDE s           and a blackout (terminal out of
#                                                         power) from OUT_FROM to OUT_TO s
#
#   sudo UD3TN=/opt/ud3tn bash relief/realnet/run.sh            (needs root for netns and tc)
#   RIDE=30 OUT_FROM=20 OUT_TO=70 to change the timing (seconds after the files are dropped)
#   CLA=mtcp to use µD3TN's minimal TCP link (no acknowledgements) instead of TCPCLv3
#
# Prints RELIEF_REALNET_RESULT {json}; keys, logs and the hub's evidence stay in the work dir.
set -euo pipefail
cd "$(dirname "$0")/../.."
UD3TN=${UD3TN:-/opt/ud3tn}
UD=$UD3TN/build/posix/ud3tn
AAPCFG="python3 $UD3TN/tools/aap/aap_config.py"
RIDE=${RIDE:-30}; OUT_FROM=${OUT_FROM:-20}; OUT_TO=${OUT_TO:-70}
CLA=${CLA:-tcpclv3}   # tcpclv3 (acknowledged) or mtcp (minimal, no acknowledgements)
WORK=${WORK:-$(mktemp -d)}
mkdir -p "$WORK"
NS=(cn cr co vi hu)
declare -A NAME=([cn]=clinic-north [cr]=clinic-river [co]=courier-07 [vi]=village-kalo [hu]=district-hub)

cleanup() {
  for n in "${NS[@]}"; do ip netns pids "rn-$n" 2>/dev/null | xargs -r kill 2>/dev/null || true; done
  sleep 0.5
  for n in "${NS[@]}" probe; do ip netns del "rn-$n" 2>/dev/null || true; done
}
trap cleanup EXIT
cleanup
in_ns() { local n=$1; shift; ip netns exec "rn-$n" "$@"; }

# ---- 1. Network: namespaces, veth links, addresses, shaping ------------------------------
for n in "${NS[@]}"; do ip netns add "rn-$n"; in_ns "$n" ip link set lo up; done
veth() { # a b subnet-octet: a gets .1, b gets .2
  ip link add "$1-$2" type veth peer name "$2-$1"
  ip link set "$1-$2" netns "rn-$1"; ip link set "$2-$1" netns "rn-$2"
  in_ns "$1" ip addr add "10.10.$3.1/30" dev "$1-$2"; in_ns "$1" ip link set "$1-$2" up
  in_ns "$2" ip addr add "10.10.$3.2/30" dev "$2-$1"; in_ns "$2" ip link set "$2-$1" up
}
veth cn co 1; veth cr co 2; veth co vi 3; veth vi hu 4

ip netns add rn-probe; ip netns exec rn-probe ip link set lo up
if ip netns exec rn-probe tc qdisc add dev lo root netem delay 1ms 2>/dev/null; then NETEM=1; else NETEM=0; fi
ip netns del rn-probe
GEO="delay 280ms 20ms distribution normal loss 1% rate 512kbit"
drop() { in_ns "$1" iptables -A OUTPUT -o "$2" -m statistic --mode random --probability "$3" -j DROP; }
if [ "$NETEM" = 1 ]; then
  for d in "cn cn-co" "co co-cn" "cr cr-co" "co co-cr"; do in_ns ${d% *} tc qdisc add dev ${d#* } root netem delay 5ms loss 0.5%; done
  in_ns co tc qdisc add dev co-vi root netem delay 10ms; in_ns vi tc qdisc add dev vi-co root netem delay 10ms
  in_ns vi tc qdisc add dev vi-hu root netem $GEO; in_ns hu tc qdisc add dev hu-vi root netem $GEO
  HUB_CLA=10.10.4.2:4224
  SHAPING="tc netem"
else
  for d in "cn cn-co" "co co-cn" "cr cr-co" "co co-cr"; do drop ${d% *} ${d#* } 0.005; done
  drop vi vi-hu 0.01; drop hu hu-vi 0.01
  in_ns vi tc qdisc add dev vi-hu root tbf rate 512kbit burst 16kb latency 2s
  in_ns hu tc qdisc add dev hu-vi root tbf rate 512kbit burst 16kb latency 2s
  in_ns vi node relief/realnet/delay-relay.mjs 127.0.0.1:5224 10.10.4.2:4224 280 20 >"$WORK/delay-relay.log" 2>&1 &
  HUB_CLA=127.0.0.1:5224
  SHAPING="iptables random loss (0.5% Wi-Fi, 1% satellite) + tbf 512 kbit/s + TCP delay relay 280 ms +-20 ms (kernel has no netem)"
fi
blackout() { # on|off: 100% packet loss on the satellite link, both directions
  if [ "$NETEM" = 1 ]; then
    if [ "$1" = on ]; then in_ns vi tc qdisc change dev vi-hu root netem loss 100%; in_ns hu tc qdisc change dev hu-vi root netem loss 100%
    else in_ns vi tc qdisc change dev vi-hu root netem $GEO; in_ns hu tc qdisc change dev hu-vi root netem $GEO; fi
  else
    local op=-I; [ "$1" = off ] && op=-D
    in_ns vi iptables $op OUTPUT -o vi-hu -j DROP; in_ns vi iptables $op INPUT -i vi-hu -j DROP
    in_ns hu iptables $op OUTPUT -o hu-vi -j DROP; in_ns hu iptables $op INPUT -i hu-vi -j DROP
  fi
}
echo "[realnet] 5 namespaces, 4 veth links; shaping: $SHAPING"

# ---- 2. Provision and start µD3TN + daemons in each namespace -----------------------------
node --input-type=module -e '
  import fs from "node:fs";
  const d = JSON.parse(fs.readFileSync("relief/kit/deployment.example.json", "utf8"));
  d.holdThresholdMs = 15000;
  fs.writeFileSync(process.argv[1], JSON.stringify(d));
' "$WORK/deployment.json"
node relief/kit/provision.mjs "$WORK/deployment.json" --out "$WORK/deploy" >/dev/null
for n in "${NS[@]}"; do
  nm=${NAME[$n]}
  in_ns "$n" "$UD" -L 2 -e "dtn://$nm.dtn/" -a 127.0.0.1 -p 4242 -S "$WORK/$nm.aap2.socket" -c "sqlite:file:$nm?mode=memory&cache=shared;$CLA:*,4224" >"$WORK/$nm.ud3tn.log" 2>&1 &
done
sleep 1.5
contact() { in_ns "$1" $AAPCFG --tcp 127.0.0.1 4242 --schedule "$2" 7200 512000 "$3" "$CLA:$4" >/dev/null 2>&1; }
contact cn 1 dtn://courier-07.dtn/ 10.10.1.2:4224
contact cr 1 dtn://courier-07.dtn/ 10.10.2.2:4224
contact co "$RIDE" dtn://village-kalo.dtn/ 10.10.3.2:4224
contact vi 1 dtn://district-hub.dtn/ "$HUB_CLA"
for n in hu vi co cn cr; do
  nm=${NAME[$n]}
  in_ns "$n" node relief/kit/node.mjs --config "$WORK/deploy/$nm.json" --data "$WORK/data/$nm" >"$WORK/$nm.log" 2>&1 &
done
sleep 2.5
echo "[realnet] µD3TN and relief daemons up in every namespace; courier reaches the village at +${RIDE}s; satellite blackout +${OUT_FROM}s to +${OUT_TO}s"

# ---- 3. Field traffic: two daily reports and a 48 KB attachment (all synthetic) -----------
node -e 'require("fs").writeFileSync(process.argv[1], require("crypto").randomBytes(48*1024))' "$WORK/scan.bin"
T0=$(date +%s.%N)
cp relief/kit/samples/clinic-north-report.json "$WORK/data/clinic-north/outbox/report-north.json"
cp relief/kit/samples/clinic-river-report.json "$WORK/data/clinic-river/outbox/report-river.json"
cp "$WORK/scan.bin" "$WORK/data/clinic-north/outbox/wound-scan-0423.bin"
echo "[realnet] +0s: 3 files dropped into the clinic outboxes"

# ---- 4. The satellite terminal loses power ------------------------------------------------
at() { python3 -c "import time,sys; t0=float(sys.argv[1]); time.sleep(max(0, t0+float(sys.argv[2])-time.time()))" "$T0" "$1"; }
at "$OUT_FROM"; blackout on;  echo "[realnet] +${OUT_FROM}s: satellite terminal OFF (100% packet loss)"
at "$OUT_TO";   blackout off; echo "[realnet] +${OUT_TO}s: satellite terminal back ON"

# ---- 5. Wait for everything to come out at the hub, then report ---------------------------
for i in $(seq 1 300); do
  [ "$(ls "$WORK/data/district-hub/inbox" 2>/dev/null | wc -l)" -ge 3 ] && break
  sleep 1
done
T1=$(date +%s.%N)
in_ns hu curl -s http://127.0.0.1:8080/api/state > "$WORK/state.json" || echo '{}' > "$WORK/state.json"
grep -hE "\] (sent|verified)" "$WORK"/*.log | sort || true
set +e
CLA="$CLA" SHAPING="$SHAPING" OUT_FROM="$OUT_FROM" OUT_TO="$OUT_TO" RIDE="$RIDE" node --input-type=module -e '
  import fs from "node:fs";
  const [stateF, work, t0, t1, scan] = process.argv.slice(1);
  const s = JSON.parse(fs.readFileSync(stateF, "utf8"));
  const short = (e) => e.replace(/^dtn:\/\/|\.dtn\/$/g, "");
  const v = (s.reports || []).filter((r) => r.status === "verified");
  const inbox = `${work}/data/district-hub/inbox`;
  const scanOut = (fs.existsSync(inbox) ? fs.readdirSync(inbox) : []).map((d) => `${inbox}/${d}/wound-scan-0423.bin`).find((p) => fs.existsSync(p));
  const identical = !!scanOut && fs.readFileSync(scanOut).equals(fs.readFileSync(scan));
  const result = {
    ok: v.length === 3 && (s.refusals || []).length === 0 && identical,
    transport: `uD3TN BPv7, ${process.env.CLA === "mtcp" ? "mtcp CLA" : "TCPCLv3 CLA (RFC 7242)"}, 5 network namespaces`, shaping: process.env.SHAPING,
    timing: { rideS: Number(process.env.RIDE), blackoutS: [Number(process.env.OUT_FROM), Number(process.env.OUT_TO)] },
    verified: v.length, refused: (s.refusals || []).length, duplicates: s.duplicates, attachmentByteIdentical: identical,
    elapsedS: Math.round(Number(t1) - Number(t0)),
    reports: v.map((r) => ({ file: r.file.name, bytes: r.file.size, chunks: r.chunkCount, route: r.route.map(short).join(" > "),
      linkS: r.hops.map((h) => `${short(h.from)}>${short(h.to)} ${(h.transitMs / 1000).toFixed(1)}`) })),
    payouts: s.payouts, refusals: s.refusals,
  };
  fs.writeFileSync(`${work}/result.json`, JSON.stringify(result, null, 2) + "\n");
  console.log("RELIEF_REALNET_RESULT " + JSON.stringify(result));
  process.exit(result.ok ? 0 : 1);
' "$WORK/state.json" "$WORK" "$T0" "$T1" "$WORK/scan.bin"
CODE=$?
echo "[realnet] work dir (keys, logs, hub inbox, evidence): $WORK"
exit $CODE
