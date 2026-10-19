# Relief network at regional scale

Run 2026-10-19 on Intel(R) Xeon(R) Processor @ 2.80GHz, Node v22.22.0, one thread. Reproduce: `node relief/scale/run.mjs --write`.

## Setup

| | |
|---|---|
| Clinics | 480 across 16 districts |
| Couriers | 48 (3 per district), a different round of clinics every day |
| Satellite relays | 16, one per district |
| Duration | 3 days in 10-minute ticks |
| Traffic | a daily report from every clinic (2 chunks); an attachment of 8 to 40 KB on 15% of clinic-days |
| Road closures | on 20% of courier-days the courier hands over at a neighbouring district's relay |
| Terminal outages | 0 to 2 a day per relay, 1 to 12 hours each, and one relay down for 30 hours |
| Custody | one batch receipt per clinic pickup (courier) and per courier handoff (relay) |
| Signing keys | 544, generated in 0.0 s |

## Delivery

| | |
|---|---|
| Payloads filed | 1,667 (227 attachments) |
| Bundles | 13,564 |
| Delivered to the hub | 12,564 |
| Still waiting at a clinic (no courier visit yet) | 1,000 |
| In relay storage at the end (terminal still down) | 0 |
| Carried via a neighbouring relay | 3,218 |
| Held in relay storage through an outage | 3,894 (median 5.0 h, 95th percentile 7.0 h, longest 26.2 h) |
| Simulation time | 0.9 s |

## Verification and settlement at the hub

| | |
|---|---|
| Delivered bundles verified (chunk against the clinic's signed root, and path from clinic to uplinking relay under pinned keys) | 12,564 of 12,564 |
| Failures | 0 |
| Signed for but not yet delivered, each located at its last custodian | 0 |
| Batch receipts | 1,318, 1,318 signature checks (each record checked once) |
| Payouts (50 sats per proven handoff) | 1,256,400 sats to 64 couriers and relays; highest relay-12 65,700, lowest courier-04c 900 |
| Settlement time | 2.8 s |

A custodian is paid for a bundle when its handoff is proven: by the next custodian's signed
receipt, or, for the last relay, by the hub receiving the bundle. So a courier is paid for what
it delivered to a relay even while that relay's terminal is still down.

## Attacks

Each attack runs on a copy of the evidence; the hub's verdict is compared with the bundles the
attack touched.

| Attack | Result |
|---|---|
| chunk altered on a courier's phone (25 bundles) | PASS: 25 of 25 refused (leaf_hash_mismatch), every other bundle still verifies |
| stolen courier identity re-signs a clinic pickup | PASS: 68 of 68 bundles in that pickup refused (signer_not_authorized), no others |
| fake clinic report: manifest signed by an unknown key | PASS: all 46 bundles of that payload refused (signer_not_pinned_source_key), no others |
| greedy courier claims 200 bundles another courier carried | PASS: all 200 still verify through the courier that really carried them; payouts unchanged (courier-00a gains 0) |
| relay replays its batch records to be paid twice | PASS: 50 replayed records change no payout (each handoff is paid once) |
| relay drops 60 bundles but signed for them | PASS: all 60 located at relay-00, which loses 60 handoffs; the couriers who handed them over are still paid |

## What this does and does not show

- Shown: at regional scale, with routes nobody planned in advance and long outages, every
  delivered bundle is verified from the records alone, every undelivered one is located at its
  last custodian, payouts follow proven handoffs only, and each attack is contained to exactly
  the bundles it touches.
- Modeled: the network (courier rounds, road closures, terminal outages) and the traffic, which is
  synthetic. Reports are not encrypted in this run; encryption is per payload and is exercised in
  `relief/kit` and `relief/realnet`.
- Assumed: batch records reach the hub (relays uplink their own and the couriers' records; a
  courier's phone also syncs its records whenever it has signal), so a relay that drops bundles
  cannot also hide the courier's record of handing them over.
