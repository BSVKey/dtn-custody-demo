#!/usr/bin/env bash
# Boot cFS with the CUSTODY app, command it from the ground side, and check its records.
set -uo pipefail
EXE=/cfs/out/exe/cpu1
cd "$EXE"
# The vehicle key for this test is the PUBLISHED relay test seed (0x02 x 32), so the
# record signed on board must equal the published vector byte for byte. Never fly it.
head -c 32 /dev/zero | tr '\000' '\002' > cf/custody_key.bin
rm -f cf/custody_*.json
./core-cpu1 > /tmp/cfs.log 2>&1 &
CFS=$!
for i in $(seq 60); do grep -q -e "CUSTODY signing key loaded" -e "no signing key" /tmp/cfs.log && break; sleep 0.5; done
sleep 1
C="node /app/flight/cfs/send-cmd.mjs"
BID=0x7ab0bc0e11b2448037d4653a64d8319f8c3f018af7bf2695a9933bfa28242785
$C noop; sleep 0.5
SEQ=1 $C sign 0xvector-001 "$BID" dtn://source/ dtn://relaya/ 1000 1050; sleep 0.5
SEQ=2 $C sign 0xpass-0142 "$BID" ipn:5.1 ipn:20.0 1790000000000 1790000000450; sleep 0.5
SEQ=3 $C sign-bad; sleep 0.5
SEQ=4 $C sign 0xbad 0xabc "dtn://a\"b/" ipn:20.0 1 2; sleep 0.5
SEQ=5 $C noop; sleep 1
kill -INT "$CFS" 2>/dev/null; sleep 1; kill -9 "$CFS" 2>/dev/null
echo "[cfs] cFS $(cd /cfs && git describe --tags 2>/dev/null), events from the CUSTODY app:"
grep -o "CUSTODY .*" /tmp/cfs.log | sed 's/^/        /'
node /app/flight/cfs/check.mjs "$EXE/cf"
CODE=$?
[ "$CODE" = 0 ] || { echo "--- cfs.log tail"; tail -30 /tmp/cfs.log; }
echo "=== CFS exit: $CODE ==="
exit "$CODE"
