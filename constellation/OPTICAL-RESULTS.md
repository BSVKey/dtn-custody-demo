# Constellation-scale custody: 4,032 satellites

Run 2026-10-19 on AMD Ryzen 5 7600 6-Core Processor, Node v24.14.1, one thread. Reproduce: `node constellation/run.mjs --links=optical --rate=10G --acq=10`.

## Setup

| | |
|---|---|
| Satellites | 4,032 (72 planes x 56) |
| Ground stations | 40, access moving every epoch |
| Bundles | 10,000 from random satellites to mission operations |
| Epochs | 40 (topology recomputed each epoch: polar cross-links down, 2% random cross-link failures) |
| Signing keys | 4,073 (one per satellite, station and operations), generated in 0.2 s |

## Optical inter-satellite links (modeled)

Modeled on public parameters, not any operator's system: ESA ESTOL v3.1 rates and re-acquisition time, which build on the SDA Optical Communications Terminal standard and CCSDS 141.11-O-1; a 5,500 km maximum link range from a vendor datasheet for an SDA OCT-class terminal. Station downlinks keep the RF model.

| | |
|---|---|
| Link rate | 10 Gbps per directed crosslink, 7,152 bundles of 1,048,576 bytes per link per tick |
| Acquisition | a cross-plane link that comes back up is unusable for 10 s (2 ticks) |
| Re-acquisitions | 7,981 |
| Hops that waited for acquisition | 438 |
| Hops that waited for link capacity | 0 |
| Crosslink length | mean 660 km, max 777 km (2.6 ms one way) |
| Batch receipts | one per node per contact, held open across epochs until the link drops |

## Delivery and routing

| | |
|---|---|
| Delivered | 10,000 of 10,000 (0 still in flight at the end) |
| Average path | 7.6 hops |
| Rerouted mid-transfer (in flight across a topology change) | 139 |
| Longer than their starting shortest path | 30 |
| Held in storage at least one tick | 313 |
| Simulation time | 1.2 s |

## Verification

| | |
|---|---|
| Bundles whose full path verified | 10,000 of 10,000 |
| Failures | 0 |
| Paths that passed back through a satellite already visited (accepted) | 11 |
| Signature checks | 15,173 (each batch verified once, shared by its bundles) |
| Verification time | 2.4 s |

## Record volume: per-bundle receipts vs batch receipts

| | Per-bundle receipts | Batch receipts | Reduction |
|---|---|---|---|
| Signatures | 75,795 | 15,173 | 5x |
| Bytes | 35,623,650 | 10,087,132 | 3.5x |

Per-bundle bytes are 470-byte JSON custody receipts, one per bundle per hop. Batch bytes are the signed batch records (7,661,692 bytes) plus a 32-byte bundle id per bundle per hop that each node keeps so any single bundle can be proven later. A binary receipt encoding would shrink both columns.

## Traffic density

The same constellation at higher load. Each batch covers every bundle a node took from one neighbour in one contact, so signatures per bundle fall as traffic grows.

| Bundles | Delivered | Verified | Hop records | Batch signatures | Signature reduction | Byte reduction | Time |
|---|---|---|---|---|---|---|---|
| 10,000 | 10,000 | 10,000 | 75,795 | 15,173 | 5.0x | 3.5x | 1.2 s + 2.4 s |
| 50,000 | 50,000 | 50,000 | 378,324 | 18,156 | 20.8x | 8.4x | 13.0 s |
| 200,000 | 200,000 | 200,000 | 1,515,154 | 18,653 | 81.2x | 12.3x | 55.4 s |

## Harsh outages

30% of cross-plane links failing each epoch; 4 ground stations, each online only 35% of epochs (no station reachable in 14 of 80 epochs); 10,000 bundles.

| | |
|---|---|
| Delivered | 10,000 (0 still in flight at the end) |
| Rerouted mid-transfer | 9,398 |
| Held in storage at least one tick | 4,561 |
| Longer than their starting shortest path | 7,775 |
| Verified | 10,000 of 10,000 (0 failures) |

## Attacks

| Attack | Bundles affected | Bundles refused | Reasons | Result |
|---|---|---|---|---|
| rogue key signs a satellite's batch | 1 | 1 | signer_not_authorized 1 | PASS |
| a batch record is withheld | 2 | 2 | wrong_destination 2 | PASS |
| a signed batch is edited | 2 | 2 | claimId_mismatch 2 | PASS |
| a bundle is claimed through a node it never visited | 1 | 1 | not_in_batch 1 | PASS |
| a satellite key is revoked as compromised | 10 | 10 | key_compromised 10 | PASS |

Each attack is caught for the bundles it touches and no others (no false alarms on the rest).

## Limits

- Orbital mechanics are a grid approximation (in-plane and cross-plane neighbours, a moving polar band, station access that shifts each epoch), not a propagated ephemeris.
- Laser links are modeled (range, acquisition, capacity), not flown: no pointing jitter, weather at ground terminals or terminal hardware is simulated, and no operator's crosslinks were used.
- Keys here come from a pinned directory; fleet provisioning, rotation and revocation are in the Operator Edition.
