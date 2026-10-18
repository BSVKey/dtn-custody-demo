#!/usr/bin/env bash
# Live: JPL ION as the BPSec security SOURCE. ION node ipn:10 sends a bundle from
# ipn:10.1 to ipn:2.1 under a source policy rule (BIB-HMAC-SHA2 over the payload, shared
# key, scope 0x07). Our receiver catches the raw bundle from ION's UDP CL, then:
#   1. verifies ION's BIB with our code (ION's MAC input, wrapped key unwrapped with
#      the shared key per RFC 9173 section 3.3.2);
#   2. checks the same BIB does not verify when the MAC input is built per RFC 9173;
#   3. stamps two custody receipts into block 224 and checks ION's BIB still verifies.
# Needs ION built with real crypto (ion/Dockerfile.bpsec).
# Run: make bpv7-bpsec-ion-source  (docker image dtn-custody-ion-bpsec, --privileged)
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
a contact +0 +3600 10 2 12500000
a range +0 +3600 10 2 1
m horizon +0
R
printf "1\na key 'custody_hmac' %s/custody.hmk\n" "$D" > "$D/node.ionsecrc"
cat > "$D/node.bprc" <<R
1
a scheme ipn 'ipnfw' 'ipnadminep'
a endpoint ipn:10.1 x
a protocol udp
a induct udp 127.0.0.1:4556 udpcli
a outduct udp 127.0.0.1:4558 udpclo
s
R
echo "a plan 2 udp/127.0.0.1:4558" > "$D/node.ipnrc"
cat > "$D/node.bpsecrc" <<'R'
1
a { "event_set": { "name": "d_integrity", "desc": "custody block interop" } }
a { "policyrule": { "desc": "ION signs the payload", "filter": { "rule_id": 1, "role": "s", "src": "ipn:10.*", "dest": "ipn:2.*", "tgt": 1 },
    "spec": { "svc": "bib-integrity", "sc_id": 1, "sc_parms": [ { "key_name": "custody_hmac" }, { "scope_flags": "7" } ] }, "es_ref": "d_integrity" } }
R
echo "custody receipts ride beside ION's BIB" > "$D/msg.txt"
node transport/bpv7/interop/cl.mjs recv udp 4558 /tmp/ionsigned.hex 40 & RECV=$!
unshare --ipc --mount --fork bash -c "
  mount -t tmpfs tmpfs /dev/shm && cd $D
  ionadmin node.ionrc >/dev/null 2>&1; sleep 1; ionsecadmin node.ionsecrc >/dev/null 2>&1; sleep 1
  bpadmin node.bprc >/dev/null 2>&1; sleep 1; ipnadmin node.ipnrc >/dev/null 2>&1
  bpsecadmin node.bpsecrc >/dev/null 2>&1; sleep 1
  bpsendfile ipn:10.1 ipn:2.1 $D/msg.txt >/dev/null 2>&1 & sleep 6
  ionstop >/dev/null 2>&1"
wait "$RECV"; RC=$?
CODE=1
[ "$RC" = 0 ] && { node --input-type=module -e '
import fs from "node:fs";
const { decodeBundle } = await import("/app/transport/bpv7/bundle.mjs");
const { verifyBibs, parseAsb, IPPT_MODE } = await import("/app/transport/bpv7/bpsec.mjs");
const { withCustody, readCustody } = await import("/app/transport/bpv7/custody-block.mjs");
const { genKeypair } = await import("/app/agent/lib/keys.mjs");
const { makeRelay } = await import("/app/agent/relay.mjs");
const { encodeBundle } = await import("/app/transport/bpv7/bundle.mjs");
const K = Buffer.from("1a2b1a2b1a2b1a2b1a2b1a2b1a2b1a2b", "hex");
const raw = Buffer.from(fs.readFileSync("/tmp/ionsigned.hex", "utf8"), "hex");
const b = decodeBundle(raw);
const bib = b.blocks.find((x) => x.type === 11);
if (!bib) { console.log("[ion-src] FAIL: ION added no BIB"); process.exit(1); }
const asb = parseAsb(bib.data);
console.log(`[ion-src] ION BIB from ${asb.source} over blocks [${asb.targets}], params [${[...asb.params.keys()]}] (2 = wrapped key)`);
const ion = verifyBibs(b, K, { mode: IPPT_MODE.ION });
const rfc = verifyBibs(b, K);
const wrong = verifyBibs(b, Buffer.alloc(16, 7), { mode: IPPT_MODE.ION });
console.log(`[ion-src] our verifier, ION MAC input: ${JSON.stringify(ion)}`);
console.log(`[ion-src] our verifier, RFC 9173 MAC input: ${JSON.stringify(rfc)}`);
console.log(`[ion-src] our verifier, wrong key: ${JSON.stringify(wrong)}`);
// Two custodians append receipts (ids taken from the BPv7 bundle id: this payload is not a chunk).
const ids = { payloadId: "ion:" + asb.source, bundleId: "ipn:10.1/" + b.primary.created.join(".") };
let x = b;
for (const [i, eid] of ["dtn://relay-a/", "dtn://relay-b/"].entries()) {
  const r = makeRelay(genKeypair(), eid).stamp(ids, i ? "dtn://relay-a/" : "ipn:10.0", 1, 2);
  x = withCustody(x, [...readCustody(x), r]);
}
const after = verifyBibs(decodeBundle(encodeBundle(x)), K, { mode: IPPT_MODE.ION });
console.log(`[ion-src] after two custody receipts appended (block 224, ${readCustody(x).length} receipts): ${JSON.stringify(after)}`);
process.exit(ion.ok && !rfc.ok && !wrong.ok && after.ok ? 0 : 1);
'; CODE=$?; }
echo "=== bpv7-bpsec-ion-source exit: $CODE (0 = ION's BIB verified by our code, survives custody receipts, wrong key refused) ==="
exit "$CODE"
