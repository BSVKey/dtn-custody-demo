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

## Found: ION LTP discarded every segment after the first (fixed by a one-line patch)

The first attempt used 200-byte LTP segments and delivered nothing in 30 minutes. A bisect
found that segments under about 575 bytes never delivered; the cause is a bug in ION's LTP
receiver, introduced upstream in nasa-jpl/ION-DTN commit 3180084 (2026-05-29, "ltp: discard
late segments when block delivered") and still on `integration` on 2026-10-22.

**Cause.** The receiver keeps the first `heapmax` bytes of each block (ltpadmin `m heapmax`,
default and minimum 560) in its heap and creates the block's overflow file only when data goes
past them, which is when `blockFileRef` is set. Commit 3180084 added a check in
`acceptRedContent()` that discards a segment as late when `blockFileRef == 0`, meaning "the
file was destroyed after delivery". But it is also 0 before the file exists. So when a block's
first segment fits in the heap, every later segment is discarded, the receiver never reports,
and the sender retransmits its checkpoint and cancels the session. ION logs nothing unless
built with `LTPDEBUG`, which shows "Discarded late segment: block already delivered" for
every segment after the first.

That explains both earlier observations: segments of 575 bytes and more overflow 560 bytes on
the first segment, so the file exists from the start; and the boundary moved with the payload
because segment headers vary by a few bytes.

**Worse than small segments.** Raising heapmax, a usual tuning step, breaks any segment size:
with `m heapmax 65536` and 1,400-byte segments, stock ION delivered nothing; every
multi-segment block under 64 KB fits the heap.

**Fix.** `ion/patches/ltp-late-segment-blockfileref.patch` treats `blockFileRef == 0` as
destroyed only once the file was created (`fileBufferPath` is set when it is created and never
cleared), so the protection against truly late segments stays.

`make ion-ltp-bug` (four runs at a 1 s light time, about 3 minutes):

| ION | 550-byte segments | 1,400-byte segments, heapmax 65536 |
|---|---|---|
| stock c5a4d87 | 0 of 21 files | 0 of 21 files |
| with the patch | 21 of 21 | 21 of 21 |

With the patch, the original Voyager configuration with 200-byte segments (240 s light time,
160 bps down, 16 bps up) passed: 2 of 2 chunks and 2 of 2 custody handoffs verified, first
arrival 301.6 s, last 382.2 s after sending. Not yet reported to ION upstream.

## Limits

- 240 s light time, not a light-day: netem caps one delay at about 268 s, and a real
  light-day run would take days of wall time per round trip.
- No bit errors or loss on the link.
- One small payload; at 160 bps a larger one would take proportionally longer (about 50 s
  per kilobyte on air).
