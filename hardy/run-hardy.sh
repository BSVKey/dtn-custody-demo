#!/usr/bin/env bash
# Our custody payload through Aalyria's Hardy BPA. Everything attaches through Hardy's
# public interfaces: the sender is a Hardy application (gRPC Application API), the
# downstream peer is a convergence layer we register (gRPC CLA API), and the schedule is
# a hardy-tvr contact plan compiled by contact-plans/compile.mjs. The route to ipn:2.* is
# closed from 15 s to 35 s; the payload is sent at about 18 s, so Hardy must hold it.
set -uo pipefail
cd /app
mkdir -p /tmp/h
cat > /tmp/h/bpa.yaml <<Y
log-level: info
admin-endpoints: ["ipn:20.0"]
grpc:
  address: "[::1]:50051"
  services: [application, cla, service, routing]
storage:
  metadata: { type: memory }
  bundle: { type: memory }
clas: []
Y
EPOCH=$(date +%s); echo $((EPOCH * 1000)) > /tmp/t0
node contact-plans/compile.mjs hardy/interop.json --hardy /tmp/h/contacts --epoch "$EPOCH"
echo "[hardy] Hardy $(cat /opt/HARDY_REVISION); contact plan compiled for hardy-tvr:"
grep -v '^#' /tmp/h/contacts | sed 's/^/        /'
printf 'bpa-address = "http://[::1]:50051"\ncontact-plan = "/tmp/h/contacts"\n' > /tmp/h/tvr.toml

hardy-bpa-server --config /tmp/h/bpa.yaml >/tmp/h/bpa.log 2>&1 & BPA=$!
sleep 2
ROLE=bridge node hardy/agent.mjs & BR=$!
sleep 1
hardy-tvr --config /tmp/h/tvr.toml >/tmp/h/tvr.log 2>&1 & TVR=$!

while [ $(( $(date +%s) - EPOCH )) -lt 18 ]; do sleep 0.2; done
date +%s%3N > /tmp/tsend
echo "[hardy] sending at +$(( ($(cat /tmp/tsend) - EPOCH * 1000) / 1000 )) s, inside the scheduled gap (15 s to 35 s)"
ROLE=source node hardy/agent.mjs
while [ $(( $(date +%s) - EPOCH )) -lt 45 ]; do sleep 0.5; done
echo "[hardy] bundles forwarded by Hardy to the custody bridge: $(ls /tmp/fwd/*.bundle 2>/dev/null | wc -l)"
node hardy/verify.mjs; CODE=$?
kill $TVR $BR $BPA 2>/dev/null
if [ "$CODE" != "0" ]; then echo "--- bpa.log"; tail -20 /tmp/h/bpa.log; echo "--- tvr.log"; tail -12 /tmp/h/tvr.log; fi
echo "=== HARDY exit: $CODE ==="
exit "$CODE"
