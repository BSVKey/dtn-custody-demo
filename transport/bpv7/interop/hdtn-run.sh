#!/usr/bin/env bash
# Live: the Custody Receipt Block through NASA HDTN, which does not know block 224.
# Our gateway agent stamps hop 1 and hands the raw bundle to HDTN (ipn:10) over STCP.
# HDTN's link to the destination (ipn:2) is scheduled down from 15 s to 35 s (the same
# compiled contact plan as hdtn/run-hdtn.sh); we send at +18 s, so HDTN must store the
# bundle and forward it at 35 s, over STCP to our destination agent, which checks the
# block arrived byte-identical, stamps hop 2 and verifies the chain.
# Run: make bpv7-block-hdtn  (docker image dtn-custody-hdtn, repo mounted at /app)
set -uo pipefail
cd /app
H=/opt/HDTN; B=$H/build; W=$(mktemp -d)
node contact-plans/compile.mjs hdtn/interop.json --hdtn "$H/module/router/contact_plans/custodyBlock.json" >/dev/null
cat > "$W/hdtn.json" <<J
{
  "hdtnConfigName": "custody block", "userInterfaceOn": false, "mySchemeName": "unused_scheme_name",
  "myNodeId": 10, "myBpEchoServiceId": 2047, "myCustodialSsp": "unused_custodial_ssp", "myCustodialServiceId": 0,
  "myRouterServiceId": 100, "isAcsAware": false, "acsMaxFillsPerAcsPacket": 100, "acsSendPeriodMilliseconds": 1000,
  "retransmitBundleAfterNoCustodySignalMilliseconds": 10000, "maxBundleSizeBytes": 10000000,
  "maxIngressBundleWaitOnEgressMilliseconds": 2000, "bufferRxToStorageOnLinkUpSaturation": false,
  "maxLtpReceiveUdpPacketSizeBytes": 1500, "neighborDepletedStorageDelaySeconds": 0, "fragmentBundlesLargerThanBytes": 0,
  "enforceBundlePriority": false, "zmqBoundRouterPubSubPortPath": 10200, "zmqBoundTelemApiPortPath": 10305,
  "inductsConfig": { "inductConfigName": "in", "inductVector": [
    { "name": "stcp_ingress", "convergenceLayer": "stcp", "boundPort": 4556, "numRxCircularBufferElements": 100, "keepAliveIntervalSeconds": 15 } ] },
  "outductsConfig": { "outductConfigName": "out", "outductVector": [
    { "name": "stcp_egress", "convergenceLayer": "stcp", "nextHopNodeId": 2, "remoteHostname": "127.0.0.1", "remotePort": 4558,
      "maxNumberOfBundlesInPipeline": 50, "maxSumOfBundleBytesInPipeline": 50000000, "keepAliveIntervalSeconds": 17 } ] },
  "storageConfig": { "storageImplementation": "asio_single_threaded", "tryToRestoreFromDisk": false, "autoDeleteFilesOnExit": true,
    "totalStorageCapacityBytes": 1024000000, "storageDeletionPolicy": "never",
    "storageDiskConfigVector": [ { "name": "d1", "storeFilePath": "$W/store1.bin" } ] }
}
J
export BUNDLE_SRC=ipn:1.1 BUNDLE_DST=ipn:2.1 VIA="unaware NASA HDTN (held across a scheduled gap)"
node transport/bpv7/interop/cl.mjs recv stcp 4558 "$W/out.hex" 60 & RECV=$!
T0=$(date +%s)
(cd "$W" && exec "$B/module/hdtn_one_process/hdtn-one-process" --contact-plan-file=custodyBlock.json --hdtn-config-file="$W/hdtn.json" >"$W/hdtn.log" 2>&1) & HP=$!
echo "[hdtn] HDTN $(cat $H/COMMIT) up as ipn:10; link to ipn:2 down from +15 s to +35 s"
while [ $(( $(date +%s) - T0 )) -lt 18 ]; do sleep 0.2; done
node transport/bpv7/interop/live.mjs make "$W/in.hex"
node transport/bpv7/interop/cl.mjs send stcp 4556 "$W/in.hex"
echo "[hdtn] sent at +$(( $(date +%s) - T0 )) s"
wait "$RECV"; RC=$?
echo "[hdtn] delivered at +$(( $(date +%s) - T0 )) s"
CODE=1
[ "$RC" = 0 ] && { node transport/bpv7/interop/live.mjs check "$W/in.hex" "$W/out.hex"; CODE=$?; }
kill -2 "$HP" 2>/dev/null; sleep 1
[ "$CODE" != 0 ] && { echo "--- hdtn.log (tail)"; tail -25 "$W/hdtn.log"; }
echo "=== bpv7-block-hdtn exit: $CODE (0 = custody block carried intact by NASA HDTN across a gap, chain verified) ==="
exit "$CODE"
