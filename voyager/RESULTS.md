# Voyager 1 and 2: custody over DTN at a light-day: PASS

Run 2026-10-21. Reproduce: `node voyager/run-voyager.mjs [--mission voyager2] [--ber 1e-5]`
(`make voyager`) and `node voyager/sweep.mjs`, each under a few seconds. Virtual time: the run
computes when each bit leaves and lands; nothing waits a light-day.

The same agent code as every other run here (chunking, Merkle root, signed manifest, a signed
custody receipt at each hop, out-of-order verification, reassembly) over a link model with
each spacecraft's numbers:

| | Voyager 1 | Voyager 2 |
|---|---|---|
| One-way light time (late October 2026, approximate) | 23.8 h (about 172 AU) | 20.0 h (about 144 AU) |
| Downlink / uplink | 160 / 16 bps | 160 / 16 bps |
| Who can send commands | any 70 m track (Goldstone or Madrid) | only DSS-43 in Canberra |
| Schedule used (illustrative, not the real one) | 8 h a day, 22 October missed | 8 h a day from Canberra, DSS-43 every third day, 34 m arrays (listen only) between |

**Voyager has to transmit a light time before a dish is pointed at it.** Its transmit
windows are the tracks moved 23.8 h (or 20 h) earlier, so a missed track tomorrow means it
must hold its data today. Bundles are sent only if they fit before the window closes; the rest
are held by the sender (the spacecraft on the way down, the DSN on the way up) and a `gap/1`
record lists which ones and why.

## The schedule is signed

Each mission's tracks are a contact plan in this repo's format: an `UP` link (commanding
tracks only) and a `DOWN` link (every track, in the spacecraft's time, which is how ION reads
a contact). It is compiled to ION and HDTN and signed as a `dtn.contact-plan/1` record
(`contact-plans/sign.mjs`, the same record Contact Plan Studio makes). The run takes its link
windows only from a plan that verifies under the scheduler's pinned key, refuses a copy with
one contact moved by 60 seconds, and checks each gap record against the signed plan: no
contact on that link was in force inside the gap.

```
voyager1: dtn.contact-plan/1 0x09397c45acc86927... (58 contacts), commanded on 29 of 29 tracks
voyager2: dtn.contact-plan/1 0x76b8a00a189604a4... (40 contacts), commanded on 10 of 30 tracks
a copy with one contact moved 60 s is refused: PASS (both)
every gap record names the signed plan and no contact was in force inside it: PASS (all four)
```

## No bit errors

| | Voyager 1 | Voyager 2 |
|---|---|---|
| Science frame down (32 KiB, 32 bundles), ready to last chunk | 40.4 h (12 bundles held overnight) | 36.6 h (23 held) |
| Command up (1 KiB, 4 bundles), ready to on board | 64.1 h (2 held past the missed track) | 84.3 h (2 held to the next DSS-43 track) |
| Command ready to the spacecraft's signed receipt at JPL | 88.2 h | 112.2 h |
| Chunks verified, custody chains, payload reassembled | all, all, yes | all, all, yes |
| Every space hop exactly one light time | yes | yes |
| One flipped bit in a command chunk | rejected | rejected |

Voyager 1 downlink, in full:

```
payload 32768 B in 32 bundles, 40448 B on the space link (Merkle + headers +23.4%)
ready 2026-10-22T13:50:00Z
space link VGR1-DSN: first bit 2026-10-22T13:50:00Z, last bit 2026-10-23T06:24:38.400Z
held 12 bundles: no window 2026-10-22T14:12:00Z to 2026-10-23T06:12:00Z
first arrival 2026-10-23T13:39:03.302Z, last 2026-10-24T06:12:38.502Z (40.4 h after ready)
```

Voyager 2 uplink and receipt:

```
payload 1024 B in 4 bundles, 1600 B on the space link (Merkle + headers +56.3%)
ready 2026-10-21T03:50:00Z
held 2 bundles: no window 2026-10-21T04:00:00Z to 2026-10-23T20:00:00Z
first arrival 2026-10-21T23:53:20.051Z, last 2026-10-24T16:06:40Z (84.3 h after ready)
VGR2's signed delivery receipt (509 B) leaves 2026-10-25T00:00:00Z, reaches JPL 2026-10-25T20:00:25.501Z
command ready to delivery confirmed at JPL: 112.2 h
```

## With bit errors

A bundle is lost with probability 1-(1-BER)^bits. When a round's last bundle has landed,
the receiver sends one NACK listing what is missing; it rides the reverse link, so a NACK
for Voyager 2's science data waits for a DSS-43 track. The sender resends once the NACK
arrives, in its next window. Bit error rates are assumed post-decoding values, 20 seeds each
(`node voyager/sweep.mjs`):

| Mission | Bit error rate | Science chunk | Science transmissions lost (mean, of bundles) | Science frame, hours to last chunk (median / worst) | Command confirmed at JPL, hours (median / worst) | Done within the 30-day plan, all verified |
|---|---|---|---|---|---|---|
| Voyager 1 | 0 | 1024 B | 0.0 of 32 | 40.4 / 40.4 | 88.2 / 88.2 | 1 of 1 |
| Voyager 1 | 0.000001 | 1024 B | 0.3 of 32 | 40.4 / 88.2 | 88.2 / 136.2 | 20 of 20 |
| Voyager 1 | 0.00001 | 1024 B | 3.5 of 32 | 88.2 / 184.2 | 88.2 / 136.2 | 20 of 20 |
| Voyager 1 | 0.0001 | 1024 B | 59.7 of 32 | 472.2 / 664.2 | 184.2 / 280.2 | 19 of 20 |
| Voyager 1 | 0.0001 | 256 B | 76.5 of 128 | 280.2 / 376.2 | 184.2 / 280.2 | 20 of 20 |
| Voyager 2 | 0 | 1024 B | 0.0 of 32 | 36.6 / 36.6 | 112.2 / 112.2 | 1 of 1 |
| Voyager 2 | 0.000001 | 1024 B | 0.3 of 32 | 36.6 / 84.2 | 112.2 / 184.2 | 20 of 20 |
| Voyager 2 | 0.00001 | 1024 B | 3.5 of 32 | 84.2 / 228.2 | 112.2 / 184.2 | 20 of 20 |
| Voyager 2 | 0.0001 | 1024 B | 54.4 of 32 | 516.2 / 660.2 | 256.2 / 400.2 | 11 of 20 |
| Voyager 2 | 0.0001 | 256 B | 76.5 of 128 | 372.2 / 516.2 | 256.2 / 400.2 | 20 of 20 |

Every run that finished verified every chunk and custody chain. A run "not done" is one
whose resends ran past the last track in the 30-day signed plan.

## Findings

- **One lost bundle costs about two days.** It is noticed a light time after it was sent,
  the NACK waits for a window and takes a light time back, and the resend waits for the
  spacecraft's next window and takes a light time down. At 1e-5 the median science frame
  goes from 40 to 88 hours.
- **For Voyager 2 the resend request waits for DSS-43.** Its NACKs and commands can only go
  up on one antenna. At 1e-4, 11 of 20 Voyager 2 runs finish inside 30 days against 19 of 20
  for Voyager 1, and command confirmation takes 112 h even with no errors (88 h for Voyager 1).
- **On a noisy link, smaller chunks win despite the overhead.** At 1e-4 a 1 KiB bundle is
  lost about 63% of the time; 256 B chunks (with more Merkle branch per byte) are lost about
  36% and finish every run, with the median down from 472 to 280 hours for Voyager 1.
- **Per-chunk Merkle branches are expensive at 16 bps.** With 64-byte command chunks the leaf
  and branch carried in each bundle cost +325% on the uplink (1,024 B became 4,352 B, about 28
  extra minutes of transmit time); 256-byte chunks bring it to +56% (5 minutes). The science
  downlink at 1 KiB chunks is +23%.
- **The delivery receipt is the slow part of knowing.** Voyager 1 had the command on board
  after 64 h; JPL held its signed proof 24 h later, because the receipt waits for the next
  transmit window and then a light time.

## Limits

- Simulation, not flight. Nothing here was sent to either Voyager; only NASA's DSN can
  command them, and they carry no Bundle Protocol or custody software.
- The DSN schedules are made up for the run. Real coverage varies day to day.
- Light times are approximations for late October 2026, held constant (they actually change
  by seconds a day).
- Bit errors are independent per bit at an assumed rate; real deep-space errors come in
  bursts after decoding. NACKs and the delivery receipt are never lost. Ground links are
  50 ms and lossless.
- Bundle headers are an estimate (48 B); the Merkle leaf and branch are counted from the real
  bundles. Custody receipts are signed at the DSN and JPL, not carried over the space link.
- Real Bundle Protocol stacks run at Mars light time in `mars/` and at Voyager's data rate in
  `ion-160bps/`; `tc netem` caps one delay at about 268 s, so a light-day on a real stack
  would need hundreds of stacked delays and days of wall time.
- An earlier IP store-and-forward run to both Voyagers over the QUIC workbench is in
  `ip-sf/RESULTS.md`.
