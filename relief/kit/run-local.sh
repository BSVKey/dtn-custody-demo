#!/usr/bin/env bash
# The field pilot kit on one machine over REAL BPv7: five µD3TN nodes (two clinics, a
# courier, a village satellite relay, the district hub), each with its relief node daemon.
# The village -> hub satellite contact opens late (the terminal is out of power), so µD3TN
# holds the bundles in the village relay's storage until it opens.
#
#   UD3TN=/opt/ud3tn bash relief/kit/run-local.sh [hold_seconds]     default 20
#
# Leaves the dashboard at http://127.0.0.1:8080/ while it waits, then prints the verdict.
set -euo pipefail
cd "$(dirname "$0")/../.."
UD3TN=${UD3TN:-/opt/ud3tn}
UD=$UD3TN/build/posix/ud3tn
CFG="python3 $UD3TN/tools/aap/aap_config.py"
HOLD=${1:-20}
WORK=$(mktemp -d)
PIDS=()
cleanup() { kill "${PIDS[@]}" 2>/dev/null || true; }
trap cleanup EXIT

# name  aap  cla
NODES=("clinic-north 4301 4401" "clinic-river 4302 4402" "courier-07 4303 4403" "village-kalo 4304 4404" "district-hub 4305 4405")

# 1. Provision the deployment with each node on its own µD3TN.
node --input-type=module -e '
  import fs from "node:fs";
  const d = JSON.parse(fs.readFileSync("relief/kit/deployment.example.json", "utf8"));
  const aap = { "clinic-north": 4301, "clinic-river": 4302, "courier-07": 4303, "village-kalo": 4304, "district-hub": 4305 };
  for (const n of d.nodes) n.aap = { host: "127.0.0.1", port: aap[n.name] };
  d.holdThresholdMs = Number(process.argv[1]) * 500; // flag any link that took over half the outage
  fs.writeFileSync(process.argv[2], JSON.stringify(d));
' "$HOLD" "$WORK/deployment.json"
node relief/kit/provision.mjs "$WORK/deployment.json" --out "$WORK/deploy" >/dev/null

# 2. Start the µD3TN nodes.
for n in "${NODES[@]}"; do
  set -- $n
  $UD -L 2 -e "dtn://$1.dtn/" -a 127.0.0.1 -p "$2" -S "$WORK/$1.aap2.socket" -c "sqlite:file:$1?mode=memory&cache=shared;mtcp:*,$3" >"$WORK/$1.ud3tn.log" 2>&1 &
  PIDS+=($!)
done
sleep 1

# 3. Contacts. Everything is up except the satellite link, which opens after HOLD seconds.
link() { $CFG --tcp 127.0.0.1 "$1" --schedule "$2" 3600 100000 "$3" "mtcp:127.0.0.1:$4" >/dev/null; }
link 4301 1 dtn://courier-07.dtn/ 4403
link 4302 1 dtn://courier-07.dtn/ 4403
link 4303 1 dtn://village-kalo.dtn/ 4404
link 4304 "$HOLD" dtn://district-hub.dtn/ 4405
echo "[kit] 5 µD3TN nodes up; satellite link village-kalo -> district-hub opens in ${HOLD}s"

# 4. Start the relief daemons (hub and relays first, so they are registered).
for n in district-hub village-kalo courier-07 clinic-north clinic-river; do
  node relief/kit/node.mjs --config "$WORK/deploy/$n.json" --data "$WORK/data/$n" >"$WORK/$n.log" 2>&1 &
  PIDS+=($!)
done
sleep 2

# 5. Two clinics drop their daily reports (synthetic) into their outboxes.
cp relief/kit/samples/clinic-north-report.json "$WORK/data/clinic-north/outbox/report-2026-10-19.json"
cp relief/kit/samples/clinic-river-report.json "$WORK/data/clinic-river/outbox/report-2026-10-19.json"
echo "[kit] reports dropped into the clinic outboxes; dashboard: http://127.0.0.1:8080/"

# 6. Wait for both to come out the other side, verified.
for i in $(seq 1 $((HOLD + 60))); do
  n=$(ls "$WORK/data/district-hub/inbox" 2>/dev/null | wc -l)
  [ "$n" -ge 2 ] && break
  sleep 1
done
echo; cat "$WORK"/*.log | grep -E "\] (sent|verified)" | sort
echo; curl -s http://127.0.0.1:8080/api/state > "$WORK/state.json"
node --input-type=module -e '
  import fs from "node:fs";
  const s = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
  const v = s.reports.filter((r) => r.status === "verified");
  console.log(`RELIEF_KIT_RESULT ${JSON.stringify({ ok: v.length === 2 && s.refusals.length === 0, verified: v.length, refused: s.refusals.length, transport: "uD3TN BPv7 (mtcp CLA)", holds: v.map((r) => r.holds.map((h) => `${h.from} -> ${h.to} ${Math.round(h.transitMs / 1000)} s`)).flat(), payouts: s.payouts })}`);
' "$WORK/state.json"
echo "[kit] work dir (keys, logs, inbox): $WORK"
[ -n "${KEEP:-}" ] && { echo "[kit] KEEP set: leaving nodes running; Ctrl-C to stop"; wait; }
