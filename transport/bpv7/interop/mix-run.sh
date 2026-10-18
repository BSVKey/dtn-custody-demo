#!/usr/bin/env bash
# Live: the Custody Receipt Block across two different BPv7 implementations in one path,
# neither of which knows block 224:
#
#   our gateway --MTCP--> uD3TN ipn:1 --TCPCLv3--> NASA HDTN ipn:10 --STCP--> our destination
#   (stamps hop 1)                                 (holds across 15 s to 35 s)  (checks, stamps hop 2)
#
# The bundle (from ipn:5.1, our gateway, to ipn:2.1) is handed to uD3TN at about +18 s,
# inside HDTN's scheduled gap to ipn:2, so it crosses from one implementation into the
# other and waits in HDTN's storage before delivery. BPSEC=1 adds a payload BIB as well.
# Run: make bpv7-block-mix  (docker image dtn-custody-mix, repo mounted at /app)
set -uo pipefail
cd /app
H=/opt/HDTN; B=$H/build; UD=/opt/ud3tn/build/posix/ud3tn; W=$(mktemp -d)
CFG="python3 /opt/ud3tn/tools/aap/aap_config.py"
node contact-plans/compile.mjs hdtn/interop.json --hdtn "$H/module/router/contact_plans/custodyBlockMix.json" >/dev/null
# HDTN's stock TCPCLv3 ingress (port 4556), with an STCP egress to our destination instead
# of TCPCLv3, so our agent can take the raw bundle off the wire.
node -e '
const fs = require("fs"), c = JSON.parse(fs.readFileSync(process.argv[1]));
c.outductsConfig.outductVector = [{ name: "stcp_egress", convergenceLayer: "stcp", nextHopNodeId: 2,
  remoteHostname: "127.0.0.1", remotePort: 4558, maxNumberOfBundlesInPipeline: 50,
  maxSumOfBundleBytesInPipeline: 50000000, keepAliveIntervalSeconds: 17 }];
c.storageConfig.storageDiskConfigVector = [{ name: "d1", storeFilePath: process.argv[3] + "/store1.bin" }];
fs.writeFileSync(process.argv[2], JSON.stringify(c, null, 1));
' "$H/config_files/hdtn/hdtn_ingress1tcpcl_port4556_egress1tcpcl_port4558flowid2.json" "$W/hdtn.json" "$W"

export BUNDLE_SRC=ipn:5.1 BUNDLE_DST=ipn:2.1 VIA="unaware uD3TN then NASA HDTN (held across a scheduled gap)"
# uD3TN ipn:1: MTCP in from our gateway (4250), TCPCLv3 out to HDTN.
(cd "$W" && exec $UD -L 2 -e ipn:1.0 -S "$W/ud1.aap2.sock" -a 127.0.0.1 -p 4241 \
  -c "sqlite:file:db4241?mode=memory&cache=shared;mtcp:*,4250;tcpclv3:*,4251" >"$W/ud.log" 2>&1) & UP=$!
node transport/bpv7/interop/cl.mjs recv stcp 4558 "$W/out.hex" 75 & RECV=$!
T0=$(date +%s)
(cd "$W" && exec "$B/module/hdtn_one_process/hdtn-one-process" --contact-plan-file=custodyBlockMix.json \
  --hdtn-config-file="$W/hdtn.json" >"$W/hdtn.log" 2>&1) & HP=$!
sleep 3
$CFG --tcp 127.0.0.1 4241 --schedule 1 3600 100000 -r ipn:2.0 ipn:10.0 tcpclv3:127.0.0.1:4556 >"$W/cfg.log" 2>&1
echo "[mix-block] uD3TN $(cat /opt/ud3tn/COMMIT) ipn:1 -> NASA HDTN $(cat $H/COMMIT) ipn:10 (link to ipn:2 down +15 s to +35 s)"
while [ $(( $(date +%s) - T0 )) -lt 18 ]; do sleep 0.2; done
node transport/bpv7/interop/live.mjs make "$W/in.hex"
node transport/bpv7/interop/cl.mjs send mtcp 4250 "$W/in.hex"
echo "[mix-block] handed to uD3TN at +$(( $(date +%s) - T0 )) s"
wait "$RECV"; RC=$?
echo "[mix-block] delivered by HDTN at +$(( $(date +%s) - T0 )) s"
CODE=1
[ "$RC" = 0 ] && { node transport/bpv7/interop/live.mjs check "$W/in.hex" "$W/out.hex"; CODE=$?; }
[ "$RC" = 0 ] && node --input-type=module -e '
const fs = await import("node:fs"); const { decodeBundle } = await import("/app/transport/bpv7/bundle.mjs");
const b = decodeBundle(Buffer.from(fs.readFileSync(process.argv[1], "utf8"), "hex"));
console.log("[mix-block] blocks on arrival: [" + b.blocks.map((x) => x.type) + "] (6 = Previous Node, 7 = Bundle Age, 10 = Hop Count, 11 = BIB, 224 = custody)");
' "$W/out.hex"
kill -2 "$HP" 2>/dev/null; kill "$UP" 2>/dev/null; sleep 1
[ "$CODE" != 0 ] && { for f in cfg.log ud.log hdtn.log; do echo "--- $f (tail)"; tail -15 "$W/$f"; done; }
echo "=== bpv7-block-mix exit: $CODE (0 = custody block carried intact across uD3TN and NASA HDTN in one path, chain verified) ==="
exit "$CODE"
