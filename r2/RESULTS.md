# R2 results: custody agent over real BPv7 (µD3TN)

R2 replaces M0's socket transport with **real Bundle Protocol v7** carried by µD3TN
(D3TN's reference implementation, built from source in `r2/Dockerfile`). The store-
and-forward is now genuine **bundle custody**: µD3TN holds the bundles in its own
storage across a scheduled contact gap and forwards them when the contact opens, which
is what real DTN does. (M0's store-and-forward was TCP retransmission; this is
application-independent DTN custody.)

## What runs

Four µD3TN nodes (`dtn://source|relaya|relayb|dest.dtn/`) chained by mtcp CLAs. Our
tested JS agent (`agent/`) runs at each node, speaking AAP v1 through a native Node
client (`r2/aap.mjs`), so none of the crypto is re-ported. Custody piggybacks in the
frame: each relay appends its signed content-addressed receipt and forwards to the next
node's agent EID. The **relaya -> relayb contact opens at +6s**, so relaya's µD3TN
stores the bundles for ~6s before forwarding.

## Result (make r2 / bash r2/run-r2.sh in the r2 image)

```
[r2] contacts configured; relaya->relayb opens at +6s (the custody hold window)
[source] sent manifest + 13 bundles into BPv7 (held by µD3TN until the next contact opens)
R2_RESULT {"ok":true,"transport":"uD3TN BPv7 (mtcp CLA)","chunks":13,"complete":true,
           "reassembledBytes":780,"rootMatches":true,"custodyChainOk":true,
           "deliveryBound":true,"gap":{"downAt":0,"upAt":6000},"elapsedMs":6871}
=== R2 exit: 0 ===
```

A payload chunked and Merkle-committed at the source, carried over real BPv7 through two
relay hops, **held in µD3TN storage across a 6s contact gap**, then at the destination:
every chunk verified against the Merkle root, the 2-hop custody chain verified, and
delivery bound to the settlement. Elapsed ~6.9s, dominated by the custody hold.

## Also proven earlier (r2 smoke)

A one-bundle `aap_send` -> `aap_receive` between two µD3TN nodes over mtcp delivered the
exact payload (`RECEIVED: [hello-over-real-bpv7]`), confirming the toolchain before the
custody wiring.

## Honest caveats

- **Custody is application-layer** (a signed receipt piggybacked in the frame), not
  BPv7's native custody signals. This is deliberate: it is portable across DTN stacks
  and verifiable offline, unlike native custody. See `../transport/bpv7-adapter.md`.
- **Delays are not real mission latencies**; the contact gap is compressed to 6s.
- **Settlement is a placeholder txid**; the live path binds a real BSV settlement.
- **Build gotcha:** µD3TN needs `libjansson-dev`; and starting several nodes with the
  same `sqlite:file::memory:?cache=shared` name races/crashes, so each node uses a
  distinct in-memory DB name (`db<port>`).

## What this closes

M0 proved the transport + netem + occultation with a socket relay. R2 proves the same
custody chain and verification over **real BPv7 with real bundle custody across a
contact gap**. The remaining seams are the mission-latency contact plans and the live
BSV settlement.
