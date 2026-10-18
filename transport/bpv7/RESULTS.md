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
| uD3TN, two nodes | none added | no gap visible (nothing to compare) |
| NASA HDTN | `ipn:10.0` | 2 custodied, 1 gap: gateway-up to dest, last unsigned `ipn:10.0` |
| JPL ION | `ipn:10.0` | same |
| Aalyria Hardy | `ipn:20.0` | 2 custodied, 1 gap, last unsigned `ipn:20.0` |
| uD3TN then HDTN | `ipn:10.0` | 2 custodied, 1 gap, last unsigned `ipn:10.0` |

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
