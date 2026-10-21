# Custody Receipt Block: results (2026-10-14, extended 2026-10-15 and 2026-10-18)

The custody chain rides inside the BPv7 bundle as extension block 224. Spec:
`spec/CUSTODY-RECORDS.md` section 2.1. Code: `cbor.mjs`, `bundle.mjs`, `custody-block.mjs`.

## Summary

| Check | Stack (none of them knows block 224) | Held across a gap | Blocks the stack added | Block 224 on arrival | Chain |
|---|---|---|---|---|---|
| Unit tests | none | n/a | n/a | n/a | 7 of 7 PASS |
| Independent codec | pyd3tn 0.15.1 (uD3TN's library) | n/a | n/a | byte-identical both ways | PASS |
| `make bpv7-block` | uD3TN, two nodes, MTCP | yes, about 5 s | none | byte-identical | PASS |
| `make bpv7-block-hdtn` | NASA HDTN 7fbe90c, STCP | yes, +20 s to +35 s | Previous Node | byte-identical | PASS |
| `make bpv7-block-ion` | JPL ION c5a4d87, UDP CL | yes, +6 s to +20 s | Previous Node, Bundle Age | byte-identical | PASS |
| `make bpv7-block-hardy` | Aalyria Hardy 0da2247, gRPC CLA | yes, +18 s to +35 s | Previous Node | byte-identical | PASS |

`make bpv7-block-all` runs the four live checks.

`make bpv7-hardy-custodian` (section 7) is the first check where a stack other than ours signs: Hardy, built with a custody-receipt filter, appends version 2 receipts itself.

## Why 224 and not 193

The block first used 193. JPL ION assigns 192 to 197 to its own blocks (data label, QoS,
SNW permits, IMC destinations, RGR, CGRR) and parsed our block as its QoS block:

```
[?] CBOR array size is wrong: 1
[?] Can't decode QOS block array.
[?] Malformed bundle: extension blocks processing.
```

ION dropped the bundle. uD3TN and HDTN define no private block types; Hardy accepted and
forwarded the block. 224 is clear of all four, and a unit test keeps it above 197.

## 1. Unit tests (`node --test test/bpv7-custody-block.test.mjs`): 7 of 7 PASS

CRC check values, CBOR shortest form, two-hop append and verify, Previous Node block used
as the previous hop, byte-identical pass-through by a node that does not know the block,
tampering refused with a reason (bit flip, dropped receipt, receipts moved to another
chunk, no block), and flags that never ask a node to drop the bundle or the block.

## 2. Independent implementation (`interop/pyd3tn-check.py`): PASS

```
1 PASS  pyd3tn re-serializes our 1073-byte bundle byte for byte (CRC-16 primary, CRC-16/32C blocks, block 224)
2 PASS  our decoder accepts pyd3tn's 188-byte bundle, block types [224, 6, 10, 1], all CRCs verified
```

pyd3tn's Python parser rejects unknown block types, so the check registers 224 with it.
The uD3TN node itself has no such limit (section 3).

## 3. Live runs

In every run our gateway agent stamps hop 1, hands the raw bundle to the stack, the stack
holds it until its contact opens, and our destination agent receives the raw bundle,
checks block 224 is byte-identical to what was sent, stamps hop 2 and verifies the chain
against its pinned keys. Raw bundles go in and out over each stack's own convergence
layer (`interop/cl.mjs`: MTCP, STCP, UDP; `interop/hardy-cla.mjs`: Hardy's gRPC CLA API).

### uD3TN (`interop/ud3tn-run.sh`)

```
[live] contacts: relaya->relayb at +1 s, relayb->dest at +6 s (relayb holds the bundle meanwhile)
[live] hop 1 (dtn://gateway-up.dtn/) stamped; bundle 2261 bytes, handed to uD3TN nodes
[mtcp] received a 2261-byte bundle on :4254
[live] delivered after 5 s
[live] sent blocks [224,1], received blocks [224,1] (the stack may add or update its own)
[live] custody block after two unaware uD3TN nodes: byte-identical
[live] hop 2 (dtn://dest.dtn/) stamped; chain of 2: {"ok":true,"hops":2,"bundleId":"0x2fbb...a916"}
=== bpv7-block exit: 0 ===
```

### NASA HDTN (`interop/hdtn-run.sh`)

```
[hdtn] HDTN 7fbe90c up as ipn:10; link to ipn:2 down from +15 s to +35 s
[live] hop 1 (dtn://gateway-up.dtn/) stamped; bundle 2222 bytes, handed to NASA HDTN (held across a scheduled gap)
[hdtn] sent at +20 s
[stcp] received a 2238-byte bundle on :4558
[hdtn] delivered at +36 s
[live] sent blocks [224,1], received blocks [6,224,1] (the stack may add or update its own)
[live] custody block after unaware NASA HDTN (held across a scheduled gap): byte-identical
[live] hop 2 (dtn://dest.dtn/) stamped; chain of 2: {"ok":true,"hops":2,"bundleId":"0x2fbb...a916"}
=== bpv7-block-hdtn exit: 0 ===
```

### JPL ION (`interop/ion-run.sh`)

```
[ion] ION c5a4d87 node ipn:10; contact 10->2 opens at +20 s
[live] hop 1 (dtn://gateway-up.dtn/) stamped; bundle 2222 bytes, handed to JPL ION (held by contact graph routing)
[ion] sent at +6 s
[udp] received a 2242-byte bundle on :4558
[ion] delivered at +21 s
[live] sent blocks [224,1], received blocks [224,6,7,1] (the stack may add or update its own)
[live] custody block after unaware JPL ION (held by contact graph routing): byte-identical
[live] hop 2 (dtn://dest.dtn/) stamped; chain of 2: {"ok":true,"hops":2,"bundleId":"0x2fbb...a916"}
=== bpv7-block-ion exit: 0 ===
```

### Aalyria Hardy (`interop/hardy-run.sh`)

```
[hardy] Hardy 0da2247 as ipn:20; route to ipn:2 down from +15 s to +35 s
[live] hop 1 (dtn://gateway-up.dtn/) stamped; bundle 2222 bytes, handed to Aalyria Hardy (held across a scheduled gap)
[hardy] dispatched our 2222-byte bundle into Hardy through the CLA API
[hardy] Hardy's verdict on the bundle: DISPATCH_VERDICT_ACCEPTED
[hardy] Hardy forwarded a 2238-byte bundle to peer ipn:30.0
[hardy] delivered at +35 s
[live] sent blocks [224,1], received blocks [224,6,1] (the stack may add or update its own)
[live] custody block after unaware Aalyria Hardy (held across a scheduled gap): byte-identical
[live] hop 2 (dtn://dest.dtn/) stamped; chain of 2: {"ok":true,"hops":2,"bundleId":"0x2fbb...a916"}
=== bpv7-block-hardy exit: 0 ===
```

## 4. BPSec beside block 224 (2026-10-18)

Code: `bpsec.mjs` (BIB-HMAC-SHA2, RFC 9173 section 3, with AES key unwrap per section
3.3.2). Unit tests: `test/bpv7-bpsec.test.mjs`, 11 of 11 PASS, including the RFC 9173
Appendix A.1, A.3 and A.4 vectors byte for byte, the RFC 3394 key wrap vector, and a
bundle captured from a live ION node that signed its payload
(`test/fixtures/ion-c5a4d87-bib.hex`).

| Check | Stack | What happened | Result |
|---|---|---|---|
| `make bpv7-bpsec-all` | uD3TN, NASA HDTN, JPL ION, Aalyria Hardy (none knows block 224) | Our source adds a full-scope (0x07) payload BIB, hop 1 appends a receipt, the stack holds the bundle across its gap; at our destination the BIB verifies on arrival and again after hop 2 appends | PASS on all four |
| `make bpv7-bpsec-ion` | JPL ION c5a4d87 with Mbed TLS, as the BIB acceptor | 4 bundles: right key (ION's MAC input) delivered; wrong key not delivered; right key with the RFC 9173 MAC input not delivered; right key again delivered | PASS (1, 0, 0, 1) |
| `make bpv7-bpsec-ion-source` | the same ION, as the BIB signer | ION signs a payload with a wrapped key; our code unwraps and verifies it, refuses a wrong key, and the BIB still verifies after two receipts are appended to block 224 | PASS |

### Findings about JPL ION (c5a4d87)

1. **The default build cannot test a BIB.** Without `--enable-crypto-mbedtls`, ION uses
   its NULL crypto suites (`ici/crypto/NULL_SUITES/csi.c`), whose verify step returns
   success for any MAC. Our first run "passed" a wrong key for that reason. The ION checks
   here use `ion/Dockerfile.bpsec`, which builds Mbed TLS 2.28 from source with NIST key
   wrap enabled (Debian's package lacks it, and ION links against it).
2. **ION's MAC input for a non-primary target is not RFC 9173's.** RFC 9173 section 3.7
   ends the integrity-protected plaintext with the target's block-type-specific data as
   a CBOR byte string; our code reproduces the Appendix A vectors that way. ION instead
   appends the whole serialized target block (header with flags 0, data, CRC):
   `bpv7/bpsec/utils/bpsec_util.c`, `canonicalizePayloadBlock`. Confirmed both ways:
   ION refuses a correctly keyed RFC 9173 BIB, and accepts the same bundle when the MAC
   input is built its way.
3. **ION defaults to HMAC 256/256 and keeps the target's CRC.** It omits the SHA variant
   parameter while signing with HMAC 256; RFC 9173 section 3.3.1 makes 384/384 the
   default. It also leaves the CRC on the target block.

`bpsec.mjs` therefore has a `mode: "ion"` option for interoperating with ION. The
default stays RFC 9173. These are reported here as observed; they have not been raised
with the ION maintainers yet.

## 5. Two implementations in one path, and the transit-gap audit (2026-10-18)

`make bpv7-block-mix` (`interop/mix-run.sh`, image `dtn-custody-mix`):

```
our gateway --MTCP--> uD3TN 00b2fbe ipn:1 --TCPCLv3--> NASA HDTN 7fbe90c ipn:10 --STCP--> our destination
(stamps hop 1)                                         (holds +15 s to +35 s)          (checks, stamps hop 2)
```

The bundle is handed to uD3TN at +20 s, inside HDTN's gap, and delivered at +36 s.
Block 224 arrives byte-identical (blocks on arrival `[6, 224, 1]`; HDTN adds Previous
Node) and the chain verifies. With `BPSEC=1` the payload BIB verifies on arrival and after
hop 2 (`[6, 11, 224, 1]`). PASS both ways.

Every live check now also audits the arrival the honest way (`auditBundleCustody`): hop 2
names the node the stack reports in its Previous Node block, so the stretch through the
unaware stack is reported as an uncustodied transit gap, not read as custody:

| Path | Previous Node on arrival | Audit |
|---|---|---|
| uD3TN, two nodes (stock build) | none added | no gap visible (nothing to compare) |
| uD3TN, two nodes, built with `BUNDLE7_TX_PRODUCE_PREVIOUS_NODE_BLOCK=1` (`make bpv7-block-prevnode`) | `dtn://relayb.dtn/` | 2 custodied, 1 gap, last unsigned `dtn://relayb.dtn/` (version 1 and version 2) |
| NASA HDTN | `ipn:10.0` | 2 custodied, 1 gap: gateway-up to dest, last unsigned `ipn:10.0` |
| JPL ION | `ipn:10.0` | same |
| Aalyria Hardy | `ipn:20.0` | 2 custodied, 1 gap, last unsigned `ipn:20.0` |
| uD3TN then HDTN | `ipn:10.0` | 2 custodied, 1 gap, last unsigned `ipn:10.0` |

Stock uD3TN does not add a Previous Node block: it is a compile-time switch, off by
default (`include/bundle7/previousnode.h`). `r2/Dockerfile.prevnode` turns it on; with it, the
uD3TN path reports its gap like the others. An operator running uD3TN who wants transit
gaps named should build with the switch on.

The audit sees only the last unsigned node; uD3TN's hop before HDTN is not visible to it,
because Previous Node is replaced at each hop. A gap means "at least this node, unsigned".

## 6. Custody receipt version 2 through the same five paths (2026-10-18)

`RECEIPT=2 BPSEC=1` with each run script: hop 1 signs a version 2 receipt (COSE_Sign1 over
CBOR, bound to the BPv7 bundle identity and a hash of the payload bytes), the stack carries
the block, hop 2 signs naming the stack's Previous Node when there is one, and the
destination runs `verifyBundleV2`. Unit tests: `test/bpv7-receipt-v2.test.mjs`, 7 of 7.

| Path | Block 224 on arrival | Payload BIB after hop 2 | Version 2 chain |
|---|---|---|---|
| uD3TN, two nodes | byte-identical | verifies | complete, 2 custodied |
| NASA HDTN | byte-identical | verifies | 2 custodied, 1 gap (last unsigned `ipn:10.0`) |
| JPL ION | byte-identical | verifies | 2 custodied, 1 gap (`ipn:10.0`) |
| Aalyria Hardy | byte-identical | verifies | 2 custodied, 1 gap (`ipn:20.0`) |
| uD3TN then NASA HDTN | byte-identical | verifies | 2 custodied, 1 gap (`ipn:10.0`) |

All exit 0. The bundle with one version 2 receipt and a BIB was 1,964 bytes, against 2,278
with one version 1 receipt and a BIB on the same path.

## 7. A second implementation inside a real BPA: Hardy signs (2026-10-18)

Sections 3 to 6 show stacks that carry block 224 without knowing it. Here Aalyria's Hardy
signs. `hardy-custody-receipt` is a new crate in a local Hardy checkout
(`../hardy-custody-receipt`, branch `custody-receipt-filter`, commits 235eed9d and b5e8dab6
on Hardy 02563815): an Egress Rewriter, the BPA filter hook that edits extension blocks per
transmission, registered in `hardy-bpa-server` behind a `custody-receipt` feature and a
`custody-receipt:` configuration section (`eid`, `key-file`, `policy`). For each forwarded
bundle it signs a version 2 receipt in Rust (COSE_Sign1, EdDSA over Ed25519, `ed25519-dalek`)
and appends it to block 224 through Hardy's scoped `ExtensionEditor`, adding the block when
absent. It hashes the payload bytes held and edits nothing but block 224. prevHop is the
Previous Node block, else the CLA ingress peer. For a fragment it names the fragment
identity `[source, [time, seq], offset, total length]` and hashes the fragment's payload.

`make bpv7-hardy-custodian` (`interop/hardy-custodian/run.sh`, image
`dtn-custody-hardy-custodian`, built from the Hardy checkout by
`interop/hardy-custodian/Dockerfile`, which also runs the crate's tests). Hardy runs twice,
once with `policy: always` and once with `policy: block-present`:

```
our CLA (as peer ipn:1.0) --gRPC CLA--> Hardy ipn:20, custody-receipt filter --gRPC CLA--> our CLA (peer ipn:30.0)
  A: no block 224                        signs, adds block 224                             verifyBundleV2
  B: one JS receipt (ipn:1.0)            signs, appends receipt 2                          verifyBundleV2, then a JS hop 3
  D1..D3: fragments of a JS-stamped      signs each fragment                               verifyBundleV2 per fragment
          bundle, block 224 in each
  F: payload under a BCB                 does not sign, logs why                           no block 224 added
  G: payload under a BCB, one JS receipt does not sign, logs why                           block 224 unchanged
  E1, E2 (policy block-present)          signs E2 (block present) only                     E1 unsigned, E2 two receipts
```

Fresh Ed25519 keys each run, Hardy's from a seed file. F and G are encrypted by Hardy's own
`bundle encrypt` (BCB-AES-GCM, A256GCM) under a fresh AES key the BPA is not given. Hardy
b5e8dab6, built clean from the commit: policy always 31 of 31 PASS, policy block-present
4 of 4 PASS, exit 0.

| Check | Result |
|---|---|
| A: Hardy adds exactly one block 224 | blocks `[1]` in, `[224, 6, 1]` out |
| A: block flags and CRC | replicate in every fragment only, CRC-32C (draft 4.2) |
| A: payload and other sent blocks | unchanged |
| A: `verifyBundleV2` (JS) on Hardy's receipt | ok, 1 custodied, complete |
| A: receipt fields | thisHop `ipn:20.0`, prevHop `ipn:1.0` (ingress peer), payloadHash of the payload sent, receivedAt <= forwardedAt, current DTN time |
| B: block 224 | one block, same number and flags, 1 receipt in, 2 out |
| B: the JS receipt after Hardy | byte-identical |
| B: payload and other sent blocks | unchanged |
| B: `verifyBundleV2` with the route pinned `[ipn:1.0, ipn:20.0]` | ok, 2 custodied, complete |
| C: a JS custodian `ipn:30.0` appends after Hardy, route `[ipn:1.0, ipn:20.0, ipn:30.0]` | ok, 3 custodied, complete |
| Control: Hardy's receipt under the wrong pinned key | refused, `signature_invalid` |
| Control: one payload bit flipped after Hardy | refused, `payload_hash_mismatch` |
| D1, D2, D3 (offsets 0, 347, 694 of a 1,040-byte ADU): still fragments, block 224 present, replicate flag set | PASS, each |
| D1 to D3: Hardy's receipt names the fragment | `["ipn:1.1", [t, 3], 0, 1040]`, `[..., 347, 1040]`, `[..., 694, 1040]`, payloadHash of that fragment's slice |
| D1 to D3: the JS whole-bundle receipt copied into each fragment | byte-identical after Hardy |
| D1 to D3: `verifyBundleV2`, route pinned `[ipn:1.0, ipn:20.0]` | ok, 2 custodied, complete each; Hardy's receipt hash-checked, the whole-bundle one listed in `hashUnchecked: [0]` (draft: a whole-bundle receipt cannot be hash-checked in a fragment) |
| F (BCB payload): blocks `[12, 1]` in, `[12, 6, 1]` out | no block 224 added, BCB and ciphertext unchanged |
| G (BCB payload, JS receipt over the ciphertext): `[12, 224, 1]` in, `[12, 224, 6, 1]` out | block 224 byte-identical, no Hardy receipt |
| G: `verifyBundleV2` | ok, 1 custodied, 1 gap: last unsigned `ipn:20.0` (the audit names Hardy as the node that held it without signing) |
| F, G: Hardy's log | 2 lines, one per bundle: `Custody Receipt Block: not signing, the payload is BCB-covered and the filter cannot read its ciphertext bundle=ipn:1.1` |
| E1 (block-present, no block 224): `[1]` in, `[6, 1]` out | no block 224 added, payload and other blocks unchanged |
| E2 (block-present, one JS receipt) | 1 receipt in, 2 out, JS receipt byte-identical; `verifyBundleV2` on `[ipn:1.0, ipn:20.0]` ok, complete |

A went from 814 to 1,014 bytes (Hardy's receipt is 170 bytes in the block, plus its
Previous Node block); B from 877 to 1,064.

Choice for a BCB-covered payload: skip, with an info-level log line, and no receipt. A
receipt's payloadHash binds the payload block's data as held, which under a BCB is the
ciphertext (`receipt-v2.mjs` hashes the same bytes, as G shows). A Rewriter reads block
bodies only through the BPA's decrypting reader: with the key it would get plaintext, which
would make a receipt no other node can check, and without the key it gets no bytes at all.
Hardy's filter interface does not expose the wire bytes of a block, so signing over the
ciphertext would need a change to Hardy itself. Skipping keeps every receipt Hardy signs
checkable, and the transit-gap audit still names the node (G above).

The encoders also agree byte for byte offline. `interop/hardy-custodian/vector.mjs` signs
two receipts with the JS code (whole bundle; fragment with subject) under a generated seed,
saved as `vector.json`; the Rust test `custody-receipt/tests/js_vector.rs` pins those bytes
and reproduces them exactly (Ed25519 is deterministic), and verifies JS receipts. The crate's
unit tests cover appending without touching earlier receipts and refusing version 1, mixed,
malformed and full (64) blocks. `custody-receipt/tests/pipeline.rs` runs the filter inside
a real Hardy BPA: a whole bundle, three fragments, a BCB-covered payload (unsigned) and
`policy: block-present` (4 tests). 10 of 10 crate tests pass; `cargo fmt --check` and
`cargo clippy -D warnings` pass on the crate and on `hardy-bpa-server` with the feature.

Limits: Hardy does not fragment on egress, so the fragments in D were made by our sender,
as a fragmenting upstream node would; Hardy signs each one as it forwards it. Nothing has
been sent upstream.

Reproduce (the Make target, or the same Docker commands where Make is not installed):

```
make bpv7-hardy-custodian                       # HARDY_SRC defaults to ../hardy-custody-receipt

docker build -t dtn-custody-hardy -f hardy/Dockerfile .
docker build -t dtn-custody-hardy-custodian --build-arg HARDY_REVISION=$(git -C ../hardy-custody-receipt rev-parse --short HEAD) \
  -f transport/bpv7/interop/hardy-custodian/Dockerfile ../hardy-custody-receipt
docker run --rm --entrypoint bash -v "$PWD:/app" dtn-custody-hardy-custodian /app/transport/bpv7/interop/hardy-custodian/run.sh

cd ../hardy-custody-receipt && cargo test -p hardy-custody-receipt   # needs Rust 1.95+
node transport/bpv7/interop/hardy-custodian/vector.mjs               # a new vector (new seed)
```

## 8. Do the stacks count hops? Yes, all four (2026-10-21)

The receipts can show that a stretch of path went unsigned, but not how long it was:
Previous Node is replaced at every hop, so plain forwarders leave no names behind. The
RFC 9171 Hop Count block (type 10) is different: every node that forwards a bundle is
meant to add 1 to it. If the stacks really do, a receipt that records the hop count it saw
when it signed lets a verifier size each gap: `next.hopCount - prev.hopCount - 1` unsigned
nodes in between. This check settles whether they do, before any receipt or draft change.

`HOPCOUNT=1` makes `interop/live.mjs` add a Hop Count block (limit 30, count 0) at the
source and report the count on arrival; `STACK_NODES` is the number of stack nodes on the
path. The same five live paths as sections 3 and 5, same images:

```
docker run --rm -e HOPCOUNT=1 -e STACK_NODES=<n> ... <image> .../<stack>-run.sh
```

| Path | Stack nodes | Blocks sent | Blocks received | Hop Count on arrival | Run |
|---|---|---|---|---|---|
| uD3TN, two nodes, MTCP | 2 | `[10, 224, 1]` | `[10, 224, 1]` | limit 30, count 2 | PASS |
| NASA HDTN 7fbe90c, STCP, held across a gap | 1 | `[10, 224, 1]` | `[6, 10, 224, 1]` | limit 30, count 1 | PASS |
| JPL ION c5a4d87, UDP CL, held by contact graph routing | 1 | `[10, 224, 1]` | `[10, 224, 6, 7, 1]` | limit 30, count 1 | PASS |
| Aalyria Hardy 0da2247, gRPC CLA, held across a gap | 1 | `[10, 224, 1]` | `[224, 6, 10, 1]` | limit 30, count 1 | PASS |
| uD3TN then NASA HDTN (TCPCLv3), held across a gap | 2 | `[10, 224, 1]` | `[6, 10, 224, 1]` | limit 30, count 2 | PASS |

Every stack adds exactly 1 per node it forwards through, keeps the limit, and the count
survives the hand-off between two implementations. Block 224 stayed byte-identical and the
custody chain verified in all five runs. Hardy reorders the blocks (224 first) and uD3TN
adds no Previous Node; neither matters for the count.

So the gap sizing proposed for draft -02 (`docs/custody-receipt-02-proposals.md`) rests
on behaviour all four stacks already have. What it does not cover: a node that drops or
does not update the block (none here did), and nodes that are not BPAs (an IP router under
a convergence layer is invisible to the count, as it is to the receipts).
