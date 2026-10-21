# JPL ION over LTP at Voyager's data rates: PASS

Run 2026-10-21. Reproduce: `make ion-voyager` (Docker, `--privileged`, about 7 minutes).
JPL ION `c5a4d87`, the Mars image and script (`mars/run-mars.sh`) with link rates added.

What this is: real ION, two nodes in their own network, IPC and mount namespaces, LTP over
UDP, with the link throttled to **Voyager's data rates, 160 bps one way and 16 bps the
other**, and a **240 s one-way light time** (netem-capped; Voyager's is about a day, see
`voyager/RESULTS.md` for the light-day model). The contact plan carries the same rates (20
and 2 bytes per second) and ranges. The script asks netem for 30% more than the planned rate,
for the UDP/IP/Ethernet headers ION's rate does not count: 208 bit on the 160 bps side. On the
16 bps side it asks for 20 bit, but tc keeps rates in whole bytes per second and rounds that
down to 2 bytes, so the uplink wire ran at exactly 16 bit, headers included (the log below).

```
[mars] ION c5a4d87; one-way light time 240 s; contact plan:
        a contact +0 +7200 1 2 20
        a range +0 +7200 1 2 240
        a contact +0 +7200 2 1 2
        a range +0 +7200 2 1 240
        qdisc netem 1: root refcnt 13 limit 100000 delay 240s rate 208bit
        qdisc netem 1: root refcnt 13 limit 100000 delay 240s rate 16bit
[ion] prepared manifest + 2 chunk files (208 bytes) in /tmp/send
[mars] node 1 handed ION 3 files at 22:43:59 UTC; waiting out the light time
[mars] received files: 3 (at 22:50:13 UTC)
MARS_RESULT {"ok":true,"transport":"JPL ION over LTP/UDP, netem 240 s each way, 160 bps down, 16 bps up",
  "ionCommit":"c5a4d87","files":3,"chunks":2,"expectedChunks":2,"accepted":2,"custodyHandoffsVerified":2,
  "complete":true,"payloadMatches":true,"firstArrivalAfterSendS":289.4,"lastArrivalAfterSendS":363.8,
  "noArrivalBeforeLightTime":true}
=== MARS exit: 0 ===
```

| Check | Result |
|---|---|
| Chunks verified against the Merkle root | 2 / 2 |
| Custody handoffs verified against the pinned sender key | 2 / 2 |
| Payload reassembled byte for byte | yes |
| First arrival after sending | 289.4 s (240 s light time plus about 49 s on air) |
| Last arrival | 363.8 s |
| Bytes on the 160 bps side (netem counter) | 3,482 in 13 packets, for 2,292 bytes of files |

Settings: LTP maximum segment size 1,400 bytes (about 70 s on air at 160 bps), span queuing
latency 60 s (a report segment takes 30-40 s at 16 bps), aggregation 10,000 bytes / 1 s.
The payload is small on purpose: 208 bytes in two 128-byte chunks, sent as three files
(manifest and two chunk records with their custody receipts) of 2,292 bytes.

## Controls

At a 10 s light time, same rates and payload:

| Run | Result | First / last arrival | Bytes down |
|---|---|---|---|
| ION paces at the link rate (`udplso` rate set) | PASS | 59.3 / 133.8 s | 4,982 in 19 packets |
| ION does not pace (`PACE=0`), netem alone limits the wire | PASS | 59.3 / 133.9 s | 4,982 in 19 packets |

Pacing in ION made no measurable difference here. It is configuration, not a finding.

## Open: LTP segments under about 575 bytes did not deliver

The first attempt used 200-byte LTP segments and delivered nothing in 30 minutes. A bisect
from the passing Mars defaults at a 10 s and then 1 s light time, **with no rate limit**,
changing one setting at a time:

| Data sender's LTP max segment size | Result |
|---|---|
| 1,400 / 1,399 / 1,200 / 1,000 / 900 / 750 / 600 / 575 | delivered |
| 550 / 512 / 508 / 400 / 300 / 200 | nothing delivered |

- Only the data sender's segment size matters; the receiver's (report) span at 508 is fine,
  and the `a protocol ltp` frame size is irrelevant. Queuing latency and payload size were
  ruled out.
- The boundary depends on the payload: 575 delivered for three payload shapes, 550 failed
  for two.
- Datagrams do reach the receiver, ION logs no error, and nothing reaches the bundle layer.

This is unexplained behaviour **in our configuration** (aggregation 10,000 bytes / 1 s,
veth with netem, ION `c5a4d87`); it is not established as an ION defect. Next step, if
wanted: a minimal two-node repro without our payload, then ION's LTP watch output from a
foreground daemon. Nothing has been reported upstream.

## Limits

- 240 s light time, not a light-day: netem caps one delay at about 268 s, and a real
  light-day run would take days of wall time per round trip.
- No bit errors or loss on the link.
- One small payload; at 160 bps a larger one would take proportionally longer (about 50 s
  per kilobyte on air).
