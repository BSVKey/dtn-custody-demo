#!/usr/bin/env bash
# Our custody payload across two DTN implementations: uD3TN (ipn:1) -> NASA HDTN router
# (ipn:10) -> uD3TN (ipn:2), TCPCLv3 on both links. HDTN routes by a contact plan
# compiled by contact-plans/compile.mjs; its link to the receiver is scheduled down from
# 15 s to 35 s and the payload is sent at about 18 s, so HDTN must store bundles it got
# from uD3TN and deliver them to uD3TN when the contact opens.
set -uo pipefail
cd /app
H=/opt/HDTN; B=$H/build; UD=/opt/ud3tn/build/posix/ud3tn
CFG="python3 /opt/ud3tn/tools/aap/aap_config.py"
node contact-plans/compile.mjs mix/interop.json --hdtn "$H/module/router/contact_plans/mixedInterop.json"
# HDTN's stock TCPCLv3 config (ingress 4556, egress to ipn:2 at 4558) with a wider egress
# window: uD3TN does not send TCPCLv3 per-bundle ACK segments, so HDTN never frees
# pipeline slots and would stop part-way through a stored backlog at the default of 20.
HCFG=/tmp/hdtn_mixed.json
node -e 'const f=process.argv[1],c=JSON.parse(require("fs").readFileSync(f));c.outductsConfig.outductVector[0].maxNumberOfBundlesInPipeline=1000;require("fs").writeFileSync(process.argv[2],JSON.stringify(c,null,1))'   "$H/config_files/hdtn/hdtn_ingress1tcpcl_port4556_egress1tcpcl_port4558flowid2.json" "$HCFG"
echo "[mix] contact plan compiled for HDTN (HDTN $(cat $H/COMMIT), uD3TN $(cat /opt/ud3tn/COMMIT))"

# uD3TN receiver ipn:2 listens for TCPCLv3 on 4558 (HDTN's egress target); uD3TN sender ipn:1.
$UD -L 2 -e ipn:2.0 -S /tmp/ud2.aap2.sock -a 127.0.0.1 -p 4244 -c "sqlite:file:db4244?mode=memory&cache=shared;tcpclv3:*,4558" >/tmp/ud_dst.log 2>&1 &
$UD -L 2 -e ipn:1.0 -S /tmp/ud1.aap2.sock -a 127.0.0.1 -p 4241 -c "sqlite:file:db4241?mode=memory&cache=shared;tcpclv3:*,4251" >/tmp/ud_src.log 2>&1 &
sleep 1
ROLE=dest AAP_PORT=4244 node mix/agent.mjs & D=$!
sleep 1

date +%s%3N > /tmp/t0
"$B/module/hdtn_one_process/hdtn-one-process" --contact-plan-file=mixedInterop.json \
  --hdtn-config-file="$HCFG" >/tmp/hdtn.log 2>&1 & HP=$!
sleep 3
# uD3TN sender: contact to the HDTN router over TCPCLv3, through which ipn:2 is reachable.
$CFG --tcp 127.0.0.1 4241 --schedule 1 3600 100000 -r ipn:2.0 ipn:10.0 tcpclv3:127.0.0.1:4556 >/tmp/cfg.log 2>&1
sleep 15
date +%s%3N > /tmp/tsend
echo "[mix] sending at +$(( ($(cat /tmp/tsend) - $(cat /tmp/t0)) / 1000 )) s, inside the scheduled HDTN -> uD3TN gap (15 s to 35 s)"
ROLE=source AAP_PORT=4241 DEST_EID=ipn:2.1 node mix/agent.mjs
wait "$D"; CODE=$?
kill -2 "$HP" 2>/dev/null; sleep 1; pkill ud3tn 2>/dev/null
if [ "$CODE" != "0" ]; then for f in /tmp/cfg.log /tmp/ud_src.log /tmp/hdtn.log /tmp/ud_dst.log; do echo "--- $f (tail)"; tail -15 "$f"; done; fi
echo "=== MIX exit: $CODE ==="
exit "$CODE"
