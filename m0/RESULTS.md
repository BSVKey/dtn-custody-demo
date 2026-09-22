# M0 spike results

R1 (transport + link shaping + occultation) is proven twice: once over a real socket
transport, once over real veths with `tc netem` and a real 100%-loss blackout.

## `make spike` (real netem, privileged Linux container)

Environment: Docker engine 28.4.0 (Linux), image = Node 20 + iproute2, run `--privileged`.

```
netns + veth + netem up. L2 = veth_ab (in n_a) is the occulted link.
qdisc netem 8003: root refcnt 13 limit 1000 delay 150ms 40ms reorder 5% 50% gap 1
[dest] listening :5403
[relayb] listening :5402 -> :5403
[relaya] listening :5401 -> :5402
[occult] L2 DOWN (100% loss on veth_ab) for 3000ms
[occult] L2 UP (shaping restored)
[source] sent manifest + 19 bundles
M0_RESULT {"ok":true,"chunks":19,"complete":true,"reassembledBytes":1200,
           "custodyChainOk":true,"deliveryBound":true,
           "gap":{"downAt":800,"upAt":3800,"delayed":19},"elapsedMs":9327}
=== M0 netem spike exit: 0 (payload survived a REAL L2 blackout and verified) ===
```

What this shows: a chunked payload crossing three shaped hops, a real 3-second L2
blackout (100% loss) partway through the transfer, and the destination still
reassembling all 19 chunks, verifying each against the Merkle root, verifying the
2-hop custody chain, producing a gap object for the outage, and binding delivery to
the settlement. Nothing gets through during the blackout; everything arrives after it
clears (elapsed ~9.3 s, dominated by the staggered send across the 3 s outage).

## `make spike-local` (real sockets, no Docker)

```
chunks delivered through blackout : 19
payload complete + reassembled    : PASS (1200 bytes)
custody chain verified            : PASS
gap object across occultation      : down@0ms up@1200ms delayed 19
delivery bound to settlement       : PASS
OVERALL                            : PASS
```

## Honest caveats (what this spike does NOT yet do)

- **Store-and-forward is TCP retransmission here**, not application custody. In the
  netem run the held bundles survive because TCP retransmits across the loss window.
  Real DTN (BPv7/µD3TN) holds bundles in application custody and forwards on contact;
  that is R2 and it does not change `agent/`.
- **The gap object's `delayed` set is approximated** as all delivered bundles in this
  spike, not per-bundle delay attribution. Precise attribution is a refinement.
- **Delay times are compressed** (150 ms/hop, 3 s outage) so a run finishes in seconds.
  Real mission latencies come from the contact plans; the one real-latency check
  (Moon, 1.3 s) is a follow-up.
- **Settlement is a placeholder txid**; the live path binds a real BSV settlement.

R2 (drop in µD3TN as the bundle agent) is the next milestone.
