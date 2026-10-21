# Voyager 1: custody over DTN at one light-day: PASS

Run 2026-10-21. Reproduce: `node voyager/run-voyager.mjs` (`make voyager`), under a second.
Virtual time: the run computes when each bit leaves and lands, nothing waits a light day.

The same agent code as every other run here (chunking, Merkle root, signed manifest, a signed
custody receipt at each hop, out-of-order verification, reassembly) over a link model with
Voyager 1's numbers:

| | |
|---|---|
| One-way light time | 23.8 h (about 172 AU, late October 2026; approximate) |
| Downlink | 160 bps |
| Uplink | 16 bps |
| DSN tracks | illustrative, not the real schedule: 06:00-14:00 UTC daily, 22 October missed |

The point the model makes explicit: **Voyager has to transmit a light time before a dish is
pointed at it.** Its transmit windows are the DSN tracks moved 23.8 h earlier, so a missed
track on Earth tomorrow means Voyager must hold its data today. Bundles are sent only if they
fit before the window closes; the rest are held by the sender (Voyager on the way down, the
DSN on the way up) and a `gap/1` record says which ones and why.

## Downlink: science frame, Voyager 1 > DSN > JPL > science team

```
payload 32768 B in 32 bundles, 40448 B on the space link (Merkle + headers +23.4%)
ready 2026-10-22T13:50:00Z
space link VGR1-DSN: first bit 2026-10-22T13:50:00Z, last bit 2026-10-23T06:24:38.400Z
held 12 bundles: no window 2026-10-22T14:12:00Z to 2026-10-23T06:12:00Z
first arrival 2026-10-23T13:39:03.302Z, last 2026-10-24T06:12:38.502Z (40.4 h after ready)
every space hop took exactly one light time: PASS
chunks verified vs Merkle root 32/32, custody chains 32/32, reassembled PASS
```

## Uplink: command load, JPL > DSN > Voyager 1, and Voyager's receipt back

```
payload 1024 B in 4 bundles, 1600 B on the space link (Merkle + headers +56.3%)
ready 2026-10-21T13:50:00Z
space link DSN-VGR1: first bit 2026-10-21T13:50:00.051Z, last bit 2026-10-23T06:06:40Z
held 2 bundles: no window 2026-10-21T14:00:00Z to 2026-10-23T06:00:00Z
first arrival 2026-10-22T13:41:20.051Z, last 2026-10-24T05:54:40Z (64.1 h after ready)
every space hop took exactly one light time: PASS
chunks verified vs Merkle root 4/4, custody chains 4/4, reassembled PASS
Voyager's signed delivery receipt (509 B) leaves 2026-10-24T06:12:00Z, reaches JPL 2026-10-25T06:00:25.501Z
receipt verifies under Voyager's pinned key and names the command's Merkle root: PASS
command ready to delivery confirmed at JPL: 88.2 h
```

A command with one flipped bit is rejected by Voyager's check against the Merkle root.

## Findings

- **Per-chunk Merkle branches are expensive at 16 bps.** With 64-byte command chunks the
  leaf and branch carried in each bundle cost +325% on the uplink (1,024 B became 4,352 B,
  about 28 extra minutes of transmit time). 256-byte chunks bring it to +56% (5 minutes); the science
  downlink at 1 KiB chunks is +23%. For the slowest links, fewer, larger chunks, or one
  signed hash per command load, is the better trade.
- **The delivery receipt is the slow part of knowing.** The command was on board 64 h after
  it was ready; JPL held Voyager's signed proof of that 24 h later (88 h in all), because the
  receipt waits for Voyager's next transmit window and then one light time.
- **A missed track costs two days, not one,** on the uplink here: the two bundles that did
  not fit before the 21 October track ended waited out the missed 22 October track.

## Limits

- Simulation, not flight. Nothing here was sent to Voyager; only NASA's DSN can command it,
  and Voyager carries no Bundle Protocol or custody software.
- The DSN schedule is made up for the run. Real Voyager 1 coverage varies day to day and
  across the three complexes.
- The light time is an approximation for late October 2026, held constant over the week
  (it actually grows by roughly 10 seconds a day at this time of year).
- No bit errors or retransmission; a bundle that is sent arrives. Ground links are 50 ms.
- Bundle headers are an estimate (48 B); the Merkle leaf and branch are counted from the
  real bundles. Custody receipts are signed at the DSN and JPL, not carried over the space
  link.
- An earlier IP store-and-forward run to Voyager 1 and 2 over the QUIC workbench is in
  `ip-sf/RESULTS.md`. Real Bundle Protocol stacks are run at Mars light time in `mars/`;
  `tc netem` caps a single delay at about 268 s, so a light-day on a real stack would need
  hundreds of stacked delays and a day of wall time per hop.
