#!/usr/bin/env bash
# Our custody payload through NASA HDTN, routed by a contact plan compiled by
# contact-plans/compile.mjs. The HDTN->receiver link is scheduled down from 15 s to 35 s;
# the payload is sent at about 18 s, so HDTN must store it and forward it at 35 s.
set -uo pipefail
cd /app
H=/opt/HDTN; B=$H/build
node contact-plans/compile.mjs hdtn/interop.json --hdtn "$H/module/router/contact_plans/custodyInterop.json"
echo "[hdtn] contact plan compiled -> module/router/contact_plans/custodyInterop.json (HDTN $(cat $H/COMMIT))"
node hdtn/prepare.mjs
mkdir -p /tmp/recv
"$B/common/bpcodec/apps/bpreceivefile" --my-uri-eid=ipn:2.1 --save-directory=/tmp/recv \
  --inducts-config-file="$H/config_files/inducts/bpsink_one_tcpclv4_port4558.json" >/tmp/recv.log 2>&1 & R=$!
sleep 2
date +%s%3N > /tmp/t0
"$B/module/hdtn_one_process/hdtn-one-process" --contact-plan-file=custodyInterop.json \
  --hdtn-config-file="$H/config_files/hdtn/hdtn_ingress1tcpclv4_port4556_egress1tcpclv4_port4558flowid2.json" >/tmp/hdtn.log 2>&1 & HP=$!
sleep 18
date +%s%3N > /tmp/tsend
echo "[hdtn] sending at +18 s, inside the scheduled gap (15 s to 35 s)"
timeout 40 "$B/common/bpcodec/apps/bpsendfile" --my-uri-eid=ipn:1.1 --dest-uri-eid=ipn:2.1 --file-or-folder-path=/tmp/send \
  --outducts-config-file="$H/config_files/outducts/bpgen_one_tcpclv4_port4556.json" --force-disable-custody >/tmp/send.log 2>&1 & S=$!
sleep 32
kill -2 "$S" 2>/dev/null; sleep 1; kill -2 "$HP" 2>/dev/null; sleep 2; kill -2 "$R" 2>/dev/null; sleep 1
echo "[hdtn] received files: $(find /tmp/recv -type f | wc -l)"
node hdtn/verify.mjs; CODE=$?
if [ "$CODE" != "0" ]; then echo "--- hdtn.log (tail)"; tail -25 /tmp/hdtn.log; echo "--- send.log (tail)"; tail -10 /tmp/send.log; echo "--- recv.log (tail)"; tail -10 /tmp/recv.log; fi
echo "=== HDTN exit: $CODE ==="
exit "$CODE"
