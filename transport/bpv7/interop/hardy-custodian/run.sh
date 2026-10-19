#!/usr/bin/env bash
# Live: the Hardy custodian filter (hardy-custody-receipt, an Egress Rewriter in Aalyria's
# Hardy BPA) signs custody receipts version 2 into block 224, checked both ways against
# our JS reference. Hardy runs as ipn:20 with the filter configured (custody-receipt:
# section of bpa.yaml); our gRPC CLA dispatches bundles as from peer ipn:1.0 and catches
# what Hardy forwards to peer ipn:30.0. custodian.mjs check runs verifyBundleV2 on them.
#   Run 1, policy always: A (no block 224), B (one JS receipt), D1..D3 (fragments of a
#     JS-stamped bundle), F and G (payload under a BCB made by Hardy's bundle tool).
#   Run 2, policy block-present: E1 (no block 224), E2 (one JS receipt).
# Run: make bpv7-hardy-custodian   (image dtn-custody-hardy-custodian, repo mounted at /app)
set -uo pipefail
cd /app
D=transport/bpv7/interop/hardy-custodian
BPA_BIN=${BPA_BIN:-/opt/custodian/hardy-bpa-server}
W=$(mktemp -d)

start_hardy() {  # $1 = policy, $2 = log file
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
  policy: $1
Y
  "$BPA_BIN" --config "$W/bpa.yaml" >"$2" 2>&1 & BPA=$!
  for _ in $(seq 1 50); do grep -q "Started successfully" "$2" && break; sleep 0.2; done
  echo "[hardy] policy $1: $(grep -o 'Custody Receipt Block custodian: signing as .*' "$2")"
}
stop_hardy() { kill $BPA 2>/dev/null; wait $BPA 2>/dev/null; }

node $D/custodian.mjs keys "$W"
node $D/custodian.mjs make "$W"
for x in f g; do
  bundle encrypt -b 1 --keys "$W/bcb-keys.json" --kid bcb -o "$W/$x.bcb.bin" "$W/$x.plain.bin" || { echo "[custodian] bundle encrypt failed"; exit 1; }
done
node $D/custodian.mjs make-bcb "$W"
echo "[custodian] Hardy $(cat /opt/custodian/HARDY_REVISION 2>/dev/null || echo local) with the custody-receipt filter, as ipn:20"

CODE=1
start_hardy always "$W/bpa1.log"
if node $D/custodian.mjs cla "$W" a b d1 d2 d3 f g; then
  stop_hardy
  BCB_LINES=$(grep -c "not signing, the payload is BCB-covered" "$W/bpa1.log")
  grep -m1 -o "Custody Receipt Block: not signing.*" "$W/bpa1.log" | sed "s/\x1b\[[0-9;]*m//g; s/^/[hardy] log: /"
  node $D/custodian.mjs check "$W" "$BCB_LINES"; CODE=$?
else
  stop_hardy
fi
[ "$CODE" != 0 ] && { echo "--- bpa1.log"; tail -30 "$W/bpa1.log"; }

CODE2=1
start_hardy block-present "$W/bpa2.log"
node $D/custodian.mjs cla "$W" e1 e2 && { node $D/custodian.mjs check-policy "$W"; CODE2=$?; }
stop_hardy
[ "$CODE2" != 0 ] && { echo "--- bpa2.log"; tail -30 "$W/bpa2.log"; }

[ "$CODE" = 0 ] && [ "$CODE2" = 0 ]; RC=$?
echo "=== bpv7-hardy-custodian exit: $RC (0 = Hardy signs receipts the JS verifier accepts, keeps and extends JS receipts, signs per fragment, leaves BCB payloads unsigned, honours block-present) ==="
exit "$RC"
