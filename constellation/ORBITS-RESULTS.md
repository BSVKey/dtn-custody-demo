# Custody over real orbits: 4,032 Starlink satellites

Run 2026-09-30 on AMD Ryzen 5 7600 6-Core Processor, Node v24.14.1, one thread. Reproduce: `node constellation/orbits-run.mjs` (fetches current elements).

## Orbital data

| | |
|---|---|
| Source | CelesTrak public GP data, Starlink group (https://celestrak.org/NORAD/elements/gp.php?GROUP=starlink&FORMAT=tle) |
| Snapshot | 10,681 element sets, fetched 2026-09-30T06:19:45Z, sha256 29776f16156ad59c... |
| Element epochs | 2026-09-21T05:49:13Z to 2026-09-30T05:11:39Z |
| Used | the first 4,032 satellites between 450 and 650 km altitude at the start time |
| Propagation | SGP4 (satellite.js), every 60 s from 2026-09-30T06:19:00Z for 40 minutes |
| Build | 0.2 s |

## Geometry, per minute (averages over the run)

| | |
|---|---|
| Inter-satellite links | 8,050 (up to 4 per satellite, within 2,500 km and clear of the Earth and lower atmosphere) |
| Mean link length and light time | 971 km, 3.24 ms |
| Links changing per minute as satellites move | 724 (links are kept while geometry allows) |
| Ground stations with a satellite above 25 degrees | 39.7 of 40 |
| Mean slant range to the chosen satellite | 558 km |
| Satellites with no link | 0 |

## Traffic and verification

| | |
|---|---|
| Bundles | 10,000 from random satellites to mission operations |
| Delivered | 10,000 (0 still in flight) |
| Average path | 8.5 hops |
| Rerouted mid-transfer (in flight across a topology change) | 1,534 |
| Longer than their starting shortest path | 589 |
| Held in storage at least one tick | 47 |
| Batch receipts | 30,632 for 84,997 hop records |
| Verified end to end | 10,000 of 10,000 (0 failures) |
| Simulation, verification | 11.9 s, 3.7 s |

## Attacks

| Attack | Bundles affected | Refused | Result |
|---|---|---|---|
| A rogue key signs a satellite's batch | 1 | 1 (signer_not_authorized) | PASS |
| The busiest satellite (ipn:4563.0) is revoked as compromised mid-run | 178 | 178 (key_compromised) | PASS |

## The whole active fleet

The same run over every Starlink satellite in the 450 to 650 km band in this snapshot
(`node constellation/orbits-run.mjs --count=20000`):

| | |
|---|---|
| Satellites | 9,732 |
| Inter-satellite links per minute | 19,451 (1,908 changing per minute) |
| Satellites with no link | 0 |
| Delivered and verified | 10,000 of 10,000, average 10.2 hops |
| Rerouted mid-transfer | 2,656 |
| Rogue key over a satellite's batch | 1 of 1 affected refused |
| Busiest satellite revoked as compromised | 157 of 157 affected refused |
| Simulation, verification | 72.8 s, 5.1 s |

## Limits

- Positions and ground visibility are real (public elements, SGP4). The laser-link layout is a geometric model: operators do not publish theirs, and real terminals have pointing, slew and acquisition limits not modelled here.
- Ground stations are public city locations standing in for gateways; station links use the two highest satellites above a 25-degree mask.
- Transport is simulated one hop per tick; link light times are reported but not added to delivery time.
