#!/usr/bin/env bash
# Live: the Custody Receipt Block through Aalyria's Hardy BPA, which does not know block
# 224. Our gateway agent stamps hop 1 and dispatches the raw bundle into Hardy through its
# gRPC convergence-layer API. Hardy's route to ipn:2 (via peer ipn:30.0) is down from
# 15 s to 35 s in the contact plan fed to hardy-tvr (the same compiled plan as
# hardy/run-hardy.sh); we send at +18 s, so Hardy must hold the bundle and forward it at
# 35 s. Our destination agent checks the block, stamps hop 2 and verifies the chain.
# Run: make bpv7-block-hardy  (docker image dtn-custody-hardy, repo mounted at /app)
set -uo pipefail
cd /app
W=$(mktemp -d)
cat > "$W/bpa.yaml" <<Y
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
EPOCH=$(date +%s)
node contact-plans/compile.mjs hardy/interop.json --hardy "$W/contacts" --epoch "$EPOCH" >/dev/null
printf 'bpa-address = "http://[::1]:50051"\ncontact-plan = "%s/contacts"\n' "$W" > "$W/tvr.toml"
hardy-bpa-server --config "$W/bpa.yaml" >"$W/bpa.log" 2>&1 & BPA=$!
sleep 2
hardy-tvr --config "$W/tvr.toml" >"$W/tvr.log" 2>&1 & TVR=$!
echo "[hardy] Hardy $(cat /opt/HARDY_REVISION) as ipn:20; route to ipn:2 down from +15 s to +35 s"
export BUNDLE_SRC=ipn:1.1 BUNDLE_DST=ipn:2.1 VIA="unaware Aalyria Hardy (held across a scheduled gap)"
while [ $(( $(date +%s) - EPOCH )) -lt 17 ]; do sleep 0.2; done
node transport/bpv7/interop/live.mjs make "$W/in.hex"
node transport/bpv7/interop/hardy-cla.mjs "$W/in.hex" "$W/out.hex" $(( (EPOCH + 18) * 1000 )) 60; RC=$?
echo "[hardy] delivered at +$(( $(date +%s) - EPOCH )) s"
CODE=1
[ "$RC" = 0 ] && { node transport/bpv7/interop/live.mjs check "$W/in.hex" "$W/out.hex"; CODE=$?; }
kill $TVR $BPA 2>/dev/null
[ "$CODE" != 0 ] && { echo "--- bpa.log"; tail -20 "$W/bpa.log"; echo "--- tvr.log"; tail -10 "$W/tvr.log"; }
echo "=== bpv7-block-hardy exit: $CODE (0 = custody block carried intact by Hardy across a gap, chain verified) ==="
exit "$CODE"
