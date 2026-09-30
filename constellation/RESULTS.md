# Constellation-scale custody: 4,032 satellites

Run 2026-09-30 on AMD Ryzen 5 7600 6-Core Processor, Node v24.14.1, one thread. Reproduce: `node constellation/run.mjs`.

## Setup

| | |
|---|---|
| Satellites | 4,032 (72 planes x 56) |
| Ground stations | 40, access moving every epoch |
| Bundles | 10,000 from random satellites to mission operations |
| Epochs | 40 (topology recomputed each epoch: polar cross-links down, 2% random cross-link failures) |
| Signing keys | 4,073 (one per satellite, station and operations), generated in 0.2 s |

## Delivery and routing

| | |
|---|---|
| Delivered | 10,000 of 10,000 (0 still in flight at the end) |
| Average path | 7.6 hops |
| Rerouted mid-transfer (in flight across a topology change) | 119 |
| Longer than their starting shortest path | 27 |
| Held in storage at least one tick | 0 |
| Simulation time | 1.5 s |

## Verification

| | |
|---|---|
| Bundles whose full path verified | 10,000 of 10,000 |
| Failures | 0 |
| Paths that passed back through a satellite already visited (accepted) | 9 |
| Signature checks | 33,568 (each batch verified once, shared by its bundles) |
| Verification time | 3.6 s |

## Record volume: per-bundle receipts vs batch receipts

| | Per-bundle receipts | Batch receipts | Reduction |
|---|---|---|---|
| Signatures | 75,766 | 33,568 | 2x |
| Bytes | 35,610,020 | 18,805,670 | 1.9x |

Per-bundle bytes are 470-byte JSON custody receipts, one per bundle per hop. Batch bytes are the signed batch records (16,381,158 bytes) plus a 32-byte bundle id per bundle per hop that each node keeps so any single bundle can be proven later. A binary receipt encoding would shrink both columns.

## Traffic density

The same constellation at higher load. Each batch covers every bundle a node took from one neighbour in one contact, so signatures per bundle fall as traffic grows.

| Bundles | Delivered | Verified | Hop records | Batch signatures | Signature reduction | Byte reduction | Time |
|---|---|---|---|---|---|---|---|
| 10,000 | 10,000 | 10,000 | 75,766 | 33,568 | 2.3x | 1.9x | 1.5 s + 3.6 s |
| 50,000 | 50,000 | 50,000 | 378,426 | 78,678 | 4.8x | 3.5x | 15.4 s |
| 200,000 | 200,000 | 200,000 | 1,514,260 | 102,308 | 14.8x | 7.2x | 43.6 s |

## Harsh outages

30% of cross-plane links failing each epoch; 4 ground stations, each online only 35% of epochs (no station reachable in 18 of 80 epochs); 10,000 bundles.

| | |
|---|---|
| Delivered | 10,000 (0 still in flight at the end) |
| Rerouted mid-transfer | 9,564 |
| Held in storage at least one tick | 9,040 |
| Longer than their starting shortest path | 5,539 |
| Verified | 10,000 of 10,000 (0 failures) |

## Attacks

| Attack | Bundles affected | Bundles refused | Reasons | Result |
|---|---|---|---|---|
| rogue key signs a satellite's batch | 1 | 1 | signer_not_authorized 1 | PASS |
| a batch record is withheld | 2 | 2 | wrong_destination 2 | PASS |
| a signed batch is edited | 1 | 1 | claimId_mismatch 1 | PASS |
| a bundle is claimed through a node it never visited | 1 | 1 | not_in_batch 1 | PASS |
| a satellite key is revoked as compromised | 9 | 9 | key_compromised 9 | PASS |

Each attack is caught for the bundles it touches and no others (no false alarms on the rest).

## Limits

- Orbital mechanics are a grid approximation (in-plane and cross-plane neighbours, a moving polar band, station access that shifts each epoch), not a propagated ephemeris.
- Transport is simulated; this measures the custody records, routing churn and verification cost, not radio or laser links.
- Keys here come from a pinned directory; fleet provisioning, rotation and revocation are in the Operator Edition.
