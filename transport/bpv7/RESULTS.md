# Custody Receipt Block: results (2026-10-14, extended 2026-10-15)

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

## Not yet run

A payload BIB (BPSec, RFC 9172) alongside block 224, and mixed chains where the bundle
crosses two different stacks in one run with the block.
