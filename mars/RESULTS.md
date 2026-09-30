# Mars light time: PASS

Run 2026-09-30. Reproduce: `make mars` (about 10 minutes). JPL ION `c5a4d87`, built from
source; Docker, `--privileged`.

Two ION nodes, each in its own network namespace, IPC namespace and `/dev/shm`, joined by
a veth pair that `tc netem` delays **240 seconds each way** (Mars near closest approach;
the one-way light time ranges from about 3 to 22 minutes). The convergence layer is
**LTP over UDP**, ION's protocol for long light times. The contact plan is compiled by
`contact-plans/compile.mjs` from `mars/interop.json`, and its ranges give LTP the same
240 s light time, so its timers match the link.

```
[mars] ION c5a4d87; one-way light time 240 s; contact plan:
        a contact +0 +7200 1 2 125000
        a range +0 +7200 1 2 240
        a contact +0 +7200 2 1 125000
        a range +0 +7200 2 1 240
        qdisc netem 8025: root refcnt 13 limit 100000 delay 240s
[mars] node 1 handed ION 21 files at 05:51:11 UTC; waiting out the light time
[mars] received files: 21 (at 05:55:21 UTC)
MARS_RESULT {"ok":true, "files":21, "chunks":20, "accepted":20, "custodyHandoffsVerified":20,
  "complete":true, "payloadMatches":true, "firstArrivalAfterSendS":240, "lastArrivalAfterSendS":240.3,
  "noArrivalBeforeLightTime":true}
=== MARS exit: 0 ===
```

| Check | Result |
|---|---|
| Chunks verified against the Merkle root | 20 / 20 |
| Custody handoffs verified against the pinned sender key | 20 / 20 |
| Payload reassembled byte for byte | yes |
| First arrival after sending | 240.0 s (the light time) |
| Anything arriving before one light time | none |

Three things were needed to make an emulated Mars link behave like a real one, each
recorded in `run-mars.sh`:

- **Static neighbour addresses.** Without them the kernel's ARP request is itself delayed
  240 s, resolution gives up after a few seconds, and every packet is dropped. A real
  deep-space link has no ARP.
- **A private `/dev/shm` per ION node.** ION keeps named semaphores there as files; two
  nodes sharing it interfere with each other.
- **An initialized ION security database** (`ionsecadmin 1`), without which bundles are
  handed to LTP but never transmitted.

Limits: one light time of 4 minutes, a clean link (no loss), and a small payload. Longer
light times, packet loss (LTP retransmission across several round trips) and multi-hop
relay through a Mars orbiter are the next runs.
