#!/usr/bin/env bash
# Live: JPL ION as the BPSec security acceptor for OUR BIB. ION node ipn:10 is the bundle
# destination, with an acceptor policy rule for a BIB-HMAC-SHA2 BIB over the payload from
# ipn:1.* and the shared key. Our source adds a full-scope (0x07) BIB, our gateway stamps
# its receipt into block 224, and the raw bundle goes to ION over UDP. Four bundles:
#   good      right key, MAC input built ION's way   ION verifies our MAC and delivers
#   wrongkey  another key, ION's way                ION must not deliver
#   rfc9173   right key, MAC input per RFC 9173     ION does not deliver: ION builds the
#             MAC input from the whole payload block, not the RFC's byte string of its data
#   good2     right key, ION's way, again           delivered (ION still healthy)
# Needs ION built with real crypto: the default build's NULL suites accept any MAC, so
# this uses ion/Dockerfile.bpsec (Mbed TLS).
# Run: make bpv7-bpsec-ion  (docker image dtn-custody-ion-bpsec, --privileged, repo at /app)
set -uo pipefail
cd /app
D=/tmp/n10; mkdir -p "$D"
printf '\x1a\x2b\x1a\x2b\x1a\x2b\x1a\x2b\x1a\x2b\x1a\x2b\x1a\x2b\x1a\x2b' > "$D/custody.hmk"  # RFC 9173 example key, test only
printf 'configFlags 1\nwmSize 5000000\nheapWords 2500000\npathName %s\n' "$D" > "$D/node.ionconfig"
cat > "$D/node.ionrc" <<R
1 10 $D/node.ionconfig
s
a contact +0 +3600 10 10 12500000
a range +0 +3600 10 10 0
m horizon +0
R
echo "1" > "$D/node.ionsecrc"; echo "a key 'custody_hmac' $D/custody.hmk" >> "$D/node.ionsecrc"
cat > "$D/node.bprc" <<R
1
a scheme ipn 'ipnfw' 'ipnadminep'
a endpoint ipn:10.1 x
a protocol udp
a induct udp 127.0.0.1:4556 udpcli
a outduct udp 127.0.0.1:4558 udpclo
s
R
cat > "$D/node.bpsecrc" <<'R'
1
a { "event_set": { "name": "d_integrity", "desc": "custody block interop" } }
a { "event": { "es_ref": "d_integrity", "event_id": "sop_corrupted_at_acceptor", "actions": [ { "id": "remove_sop_target" } ] } }
a { "event": { "es_ref": "d_integrity", "event_id": "sop_missing_at_acceptor", "actions": [ { "id": "remove_sop_target" } ] } }
R
# ION reports a MAC that does not verify as sop_misconfigured_at_acceptor, not as
# sop_corrupted_at_acceptor (library/ext/bpsec/bib.c: the HMAC context returns 0 on a
# mismatch, and 0 is handled as misconfiguration). ION_MISCONF_EVENT=0 leaves that event
# unhandled, which is how ION's own test configurations are written.
[ "${ION_MISCONF_EVENT:-1}" = 1 ] && echo 'a { "event": { "es_ref": "d_integrity", "event_id": "sop_misconfigured_at_acceptor", "actions": [ { "id": "remove_sop_target" } ] } }' >> "$D/node.bpsecrc"
cat >> "$D/node.bpsecrc" <<'R'
a { "policyrule": { "desc": "accept our payload BIB", "filter": { "rule_id": 1, "role": "a", "src": "ipn:1.*", "dest": "ipn:10.*", "tgt": 1 },
    "spec": { "svc": "bib-integrity", "sc_id": 1, "sc_parms": [ { "key_name": "custody_hmac" } ] }, "es_ref": "d_integrity" } }
R
export BUNDLE_SRC=ipn:1.1 BUNDLE_DST=ipn:10.1 BPSEC=1
BIB_IPPT=ion node transport/bpv7/interop/live.mjs make /tmp/good.hex >/dev/null
BIB_IPPT=ion BIB_KEY_HEX=000102030405060708090a0b0c0d0e0f node transport/bpv7/interop/live.mjs make /tmp/wrongkey.hex >/dev/null
BIB_IPPT=rfc9173 node transport/bpv7/interop/live.mjs make /tmp/rfc9173.hex >/dev/null
BIB_IPPT=ion node transport/bpv7/interop/live.mjs make /tmp/good2.hex >/dev/null
node -e 'const{decodeBundle}=await import("/app/transport/bpv7/bundle.mjs");const fs=await import("node:fs");console.log("[ion-bpsec] bundles carry blocks ["+decodeBundle(Buffer.from(fs.readFileSync("/tmp/good.hex","utf8"),"hex")).blocks.map(b=>b.type)+"]: BIB, custody block 224 (hop 1), payload")' --input-type=module

unshare --ipc --mount --fork bash -c "
  mount -t tmpfs tmpfs /dev/shm && cd $D
  ionadmin node.ionrc >/dev/null 2>&1; sleep 1; ionsecadmin node.ionsecrc >/dev/null 2>&1; sleep 1
  bpadmin node.bprc >/dev/null 2>&1; sleep 1; bpsecadmin node.bpsecrc >$D/bpsec.out 2>&1; sleep 1
  bpsink ipn:10.1 > $D/sink.txt 2>&1 &
  sleep 2
  n() { grep -ci 'payload delivered' $D/sink.txt; }
  for b in good wrongkey rfc9173 good2; do
    before=\$(n)
    node /app/transport/bpv7/interop/cl.mjs send udp 4556 /tmp/\$b.hex; sleep 4
    echo \"[ion-bpsec] \$b: delivered to ipn:10.1 = \$(( \$(n) - before ))\" | tee -a $D/result.txt
  done
  grep -iE 'bib|integrity|corrupt|sop' $D/ion.log | grep -viE 'event_set|policyrule' | tail -4 | sed 's/^/        ion.log: /'
  ionstop >/dev/null 2>&1"
G=$(grep -c '^\[ion-bpsec\] good: delivered to ipn:10.1 = 1' "$D/result.txt"); W=$(grep -c 'wrongkey: delivered to ipn:10.1 = 0' "$D/result.txt")
R=$(grep -c 'rfc9173: delivered to ipn:10.1 = 0' "$D/result.txt"); G2=$(grep -c 'good2: delivered to ipn:10.1 = 1' "$D/result.txt")
CODE=1; [ "$G$W$R$G2" = "1111" ] && CODE=0
[ "$CODE" != 0 ] && { echo "--- bpsecadmin"; tail -5 "$D/bpsec.out"; echo "--- ion.log"; tail -15 "$D/ion.log"; }
echo "=== bpv7-bpsec-ion exit: $CODE (0 = ION verified our BIB: right key delivered, wrong key and RFC-9173-built MAC refused) ==="
exit "$CODE"
