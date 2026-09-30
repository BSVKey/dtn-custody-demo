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

## Relay through a Mars orbiter, with packet loss: PASS

Run 2026-09-30. Reproduce: `docker run --rm --privileged -e OWLT=240 -e LOSS=5 --entrypoint bash dtn-custody-mars mars/run-relay.sh`.

Three ION nodes, each in its own namespaces: a rover (`ipn:3`), a relay orbiter (`ipn:1`) and
Earth (`ipn:2`). Rover to orbiter is a 10 ms link; orbiter to Earth is **240 s each way with
5% packet loss in both directions**, and its contact opens only 120 s after start (Earth
not yet in view), so the orbiter must hold the rover's data and LTP must repair the losses
across the light time. The contact plan is compiled from `mars/relay.json`.

```
[relay] rover handed ION 21 files at 06:15:39 UTC; the orbiter holds them until Earth is in view at +120 s
[relay] received at Earth: 21 files (at 06:29:36 UTC)
[relay] orbiter vo2: Sent 27267 bytes 34 pkt (dropped 1, overlimits 0 requeues 0)
[relay] Earth ve: Sent 1030 bytes 14 pkt (dropped 1, overlimits 0 requeues 0)
[relay] earliest physically possible arrival: 344 s after sending
MARS_RESULT {"ok":true, "transport":"JPL ION LTP relay: rover ipn:3 -> orbiter ipn:1 -> Earth ipn:2; orbiter-Earth 240 s each way, 5% loss each way",
  "files":21, "chunks":20, "accepted":20, "custodyHandoffsVerified":20, "complete":true, "payloadMatches":true,
  "firstArrivalAfterSendS":345.7, "lastArrivalAfterSendS":826.7, "noArrivalBeforeLightTime":true}
=== RELAY exit: 0 ===
```

The emulator dropped one data packet toward Earth and one report packet back toward the
orbiter. LTP repaired both: the first files arrived 345.7 s after sending (the earliest
physically possible was 344 s: the contact opening plus one light time), and the last at
826.7 s, one repair round trip (2 x 240 s) later. Every chunk and custody handoff verified.

## Longer light times

`netem` refuses a single delay above about 4.5 minutes, so `run-mars.sh` builds longer
light times from stacked netem stages of at most 240 s (a 6 s check built from two 3 s
stages delivered at exactly 6.0 s). Runs at 750 s (average Mars distance) and 1,320 s (near
maximum) are recorded below when complete.

Limits: small payloads, one relay, uniform random loss (no bursts), and no
light-time change during the run.
