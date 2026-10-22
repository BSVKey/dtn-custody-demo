#!/usr/bin/env bash
# The Solar System Internet on real BPAs: ten Hardy nodes (custody-receipt filter on every
# custodian), each with its own time-variant routing agent, linked by the emulated space links
# and endpoints of net.mjs, then the report (report.mjs).
# Run: make ssi-hardy   (image dtn-custody-hardy-custodian, repo mounted at /app)
set -uo pipefail
cd /app
D=$(mktemp -d)
BPA=${BPA_BIN:-/opt/custodian/hardy-bpa-server}
T0=$(( ($(date +%s) + 25) * 1000 ))
node ssi/hardy/plan.mjs "$D" "$T0" || exit 1
echo "[ssi-hardy] Hardy $(cat /opt/custodian/HARDY_REVISION 2>/dev/null) with the custody-receipt filter"
PIDS=()
for n in "$D"/n[0-9]*; do
  "$BPA" --config "$n/bpa.yaml" >"$n/bpa.log" 2>&1 & PIDS+=($!)
done
for n in "$D"/n[0-9]*; do
  for _ in $(seq 1 75); do grep -q "Started successfully" "$n/bpa.log" && break; sleep 0.2; done
  grep -q "Started successfully" "$n/bpa.log" || { echo "[ssi-hardy] $(basename "$n") did not start"; tail -5 "$n/bpa.log"; }
done
node ssi/hardy/net.mjs "$D" & NET=$!
for _ in $(seq 1 100); do [ -f "$D/net.ready" ] && break; sleep 0.2; done
for n in "$D"/n[0-9]*; do hardy-tvr --config "$n/tvr.toml" >"$n/tvr.log" 2>&1 & PIDS+=($!); done
echo "[ssi-hardy] ${#PIDS[@]} Hardy processes running (BPAs and routing agents); scenario starts at $(date -u -d @$((T0 / 1000)) +%H:%M:%S) UTC"
wait "$NET"
kill "${PIDS[@]}" 2>/dev/null
node ssi/hardy/report.mjs "$D"; CODE=$?
# Keep what the explorer and the payment need (never plan.json: it holds the run's keys).
OUT=/app/ssi/hardy/out/$(date -u +%Y%m%dT%H%M%SZ); mkdir -p "$OUT"
cp "$D/report.json" "$OUT/" 2>/dev/null
node -e 'const r=require(process.argv[1]); for (const d of r.deliveries) delete d.data; require("fs").writeFileSync(process.argv[2], JSON.stringify(r))' "$D/results.json" "$OUT/results.json" 2>/dev/null
echo "[ssi-hardy] outputs in ssi/hardy/out/$(basename "$OUT")"
if [ "$CODE" != 0 ]; then for n in "$D"/n2[0-9]; do echo "--- $(basename "$n") bpa.log"; tail -5 "$n/bpa.log"; echo "--- tvr.log"; tail -5 "$n/tvr.log"; done; fi
echo "=== ssi-hardy exit: $CODE ==="
exit "$CODE"
