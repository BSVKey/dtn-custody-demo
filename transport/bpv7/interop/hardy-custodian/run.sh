#!/usr/bin/env bash
# Live: the Hardy custodian filter (hardy-custody-receipt, an Egress Rewriter in Aalyria's
# Hardy BPA) signs custody receipts version 2 into block 224, checked both ways against
# our JS reference. Hardy runs as ipn:20 with the filter configured (custody-receipt:
# section of bpa.yaml); our gRPC CLA dispatches bundle A (no block 224) and bundle B (one
# receipt signed by the JS custodian ipn:1.0) as from peer ipn:1.0 and catches what Hardy
# forwards to peer ipn:30.0. custodian.mjs check runs verifyBundleV2 on both.
# Run: make bpv7-hardy-custodian   (image dtn-custody-hardy-custodian, repo mounted at /app)
set -uo pipefail
cd /app
D=transport/bpv7/interop/hardy-custodian
BPA_BIN=${BPA_BIN:-/opt/custodian/hardy-bpa-server}
W=$(mktemp -d)
node $D/custodian.mjs keys "$W"
cat > "$W/bpa.yaml" <<Y
log-level: ${HARDY_LOG:-info}
admin-endpoints: ["ipn:20.0"]
grpc:
  address: "[::1]:50051"
  services: [application, cla, service, routing]
storage:
  metadata: { type: memory }
  bundle: { type: memory }
clas: []
custody-receipt:
  eid: "ipn:20.0"
  key-file: "$W/hardy.seed"
Y
echo "[custodian] Hardy $(cat /opt/custodian/HARDY_REVISION 2>/dev/null || echo local) with the custody-receipt filter, as ipn:20"
"$BPA_BIN" --config "$W/bpa.yaml" >"$W/bpa.log" 2>&1 & BPA=$!
for _ in $(seq 1 50); do grep -q "Started successfully" "$W/bpa.log" && break; sleep 0.2; done
grep -o "Custody Receipt Block custodian: signing as .*" "$W/bpa.log" | sed 's/^/[hardy] /'
node $D/custodian.mjs make "$W"
CODE=1
node $D/custodian.mjs cla "$W" && { node $D/custodian.mjs check "$W"; CODE=$?; }
kill $BPA 2>/dev/null
[ "$CODE" != 0 ] && { echo "--- bpa.log"; tail -30 "$W/bpa.log"; }
echo "=== bpv7-hardy-custodian exit: $CODE (0 = Hardy signs receipts the JS verifier accepts, and keeps and extends JS receipts) ==="
exit "$CODE"
