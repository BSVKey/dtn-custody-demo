#!/usr/bin/env bash
# Lost-chunk resend over REAL BPv7: four µD3TN nodes (clinic, courier, village relay, hub) on
# TCPCLv3 with links both ways. A 2 MB file (about 2,000 chunks) is sent, and the courier phone's
# relief app is killed partway through and restarted a few seconds later. µD3TN does not hold
# bundles for an application that is not running, so the chunks that arrive meanwhile are lost
# at the courier; the hub notices the report is incomplete and asks the clinic, through the
# relays, to resend exactly what is missing.
#
#   UD3TN=/opt/ud3tn bash relief/realnet/resend-crash.sh
# Prints RELIEF_RESEND_RESULT {json}.
set -euo pipefail
cd "$(dirname "$0")/../.."
UD3TN=${UD3TN:-/opt/ud3tn}
UD=$UD3TN/build/posix/ud3tn
CFG="python3 $UD3TN/tools/aap/aap_config.py"
WORK=${WORK:-$(mktemp -d)}; mkdir -p "$WORK"
PIDS=()
trap 'kill "${PIDS[@]}" 2>/dev/null || true' EXIT
NODES=("clinic-north 4501 4601" "courier-07 4503 4603" "village-kalo 4504 4604" "district-hub 4505 4605")

node --input-type=module -e '
  import fs from "node:fs";
  const d = JSON.parse(fs.readFileSync("relief/kit/deployment.example.json", "utf8"));
  d.nodes = d.nodes.filter((n) => n.name !== "clinic-river");
  const aap = { "clinic-north": 4501, "courier-07": 4503, "village-kalo": 4504, "district-hub": 4505 };
  for (const n of d.nodes) { n.aap = { host: "127.0.0.1", port: aap[n.name] }; if (n.role === "hub") n.dashboard = { host: "127.0.0.1", port: 8091 }; }
  d.resendAfterMs = 8000; d.holdThresholdMs = 60000;
  fs.writeFileSync(process.argv[1], JSON.stringify(d));' "$WORK/deployment.json"
node relief/kit/provision.mjs "$WORK/deployment.json" --out "$WORK/deploy" >/dev/null
for n in "${NODES[@]}"; do
  set -- $n
  $UD -L 2 -e "dtn://$1.dtn/" -a 127.0.0.1 -p "$2" -S "$WORK/$1.aap2.socket" -c "sqlite:file:$1?mode=memory&cache=shared;tcpclv3:*,$3" >"$WORK/$1.ud3tn.log" 2>&1 &
  PIDS+=($!)
done
sleep 1
link() { $CFG --tcp 127.0.0.1 "$1" --schedule 1 3600 100000000 "$2" "tcpclv3:127.0.0.1:$3" >/dev/null 2>&1; }
link 4501 dtn://courier-07.dtn/ 4603; link 4503 dtn://village-kalo.dtn/ 4604; link 4504 dtn://district-hub.dtn/ 4605   # toward the hub
link 4505 dtn://village-kalo.dtn/ 4604; link 4504 dtn://courier-07.dtn/ 4603; link 4503 dtn://clinic-north.dtn/ 4601    # back to the clinic
sleep 1.5
start() { node relief/kit/node.mjs --config "$WORK/deploy/$1.json" --data "$WORK/data/$1" >>"$WORK/$1.log" 2>&1 & echo $!; }
for n in district-hub village-kalo clinic-north; do PIDS+=($(start $n)); done
COURIER=$(start courier-07); PIDS+=($COURIER)
sleep 2

node -e 'require("fs").writeFileSync(process.argv[1], require("crypto").randomBytes(2 * 1024 * 1024))' "$WORK/survey-photos.bin"
cp "$WORK/survey-photos.bin" "$WORK/data/clinic-north/outbox/survey-photos.bin"
claims() { wc -l < "$WORK/data/courier-07/claims.jsonl" 2>/dev/null || echo 0; }
for i in $(seq 1 200); do [ "$(claims)" -ge 300 ] && break; sleep 0.1; done
kill -9 "$COURIER"; CRASHED_AT=$(claims)
echo "[resend] courier app killed after taking $CRASHED_AT chunks"
sleep 4
PIDS+=($(start courier-07)); echo "[resend] courier app restarted"
for i in $(seq 1 180); do [ "$(ls "$WORK/data/district-hub/inbox" 2>/dev/null | wc -l)" -ge 1 ] && break; sleep 1; done

curl -s http://127.0.0.1:8091/api/state > "$WORK/state.json" || echo '{}' > "$WORK/state.json"
set +e
CRASHED_AT="$CRASHED_AT" node --input-type=module -e '
  import fs from "node:fs";
  const [stateF, work] = process.argv.slice(1);
  const s = JSON.parse(fs.readFileSync(stateF, "utf8"));
  const r = (s.reports || [])[0] || {};
  const inbox = `${work}/data/district-hub/inbox`;
  const out = (fs.existsSync(inbox) ? fs.readdirSync(inbox) : []).map((d) => `${inbox}/${d}/survey-photos.bin`).find((p) => fs.existsSync(p));
  const identical = !!out && fs.readFileSync(out).equals(fs.readFileSync(`${work}/survey-photos.bin`));
  const asked = fs.readFileSync(`${work}/clinic-north.log`, "utf8").match(/sent \d+ frames again/g) || [];
  const result = {
    ok: r.status === "verified" && identical && (s.refusals || []).length === 0,
    transport: "uD3TN BPv7, TCPCLv3 CLA, links both ways", fileBytes: 2 * 1024 * 1024, chunks: r.chunkCount,
    courierTookBeforeCrash: Number(process.env.CRASHED_AT), status: r.status, byteIdentical: identical,
    resendRequests: s.resendRequests, clinicResent: asked.map((a) => Number(a.match(/\d+/)[0])),
    refused: (s.refusals || []).length, duplicates: s.duplicates,
  };
  fs.writeFileSync(`${work}/result.json`, JSON.stringify(result, null, 2) + "\n");
  console.log("RELIEF_RESEND_RESULT " + JSON.stringify(result));
  process.exit(result.ok ? 0 : 1);
' "$WORK/state.json" "$WORK"
CODE=$?
echo "[resend] work dir: $WORK"
exit $CODE
