# Changelog

## 2026-09-30

### Added

- **Batch receipts** (`custody-batch/1`, `agent/lib/batch.mjs`). One signed record per
  node per contact covering every bundle taken in it; any single bundle is proven with
  a short inclusion proof. Added to the specification and test vectors, and to the
  onboard C signer (`ck_batch`), byte-identical to the vector.
- **Verification over routes nobody listed in advance** (`agent/lib/path.mjs`). Accepts
  any path that is authorized at every hop, links hop to hop, moves forward in time and
  covers the bundle; revisits after a reroute are accepted and counted.
- **Constellation simulation** (`constellation/`). 4,032 satellites, changing routes,
  ground-station outages, load up to 200,000 bundles, and attack cases.
- **Mars light time** (`mars/`). JPL ION over LTP at 4, 12.5 and 22 minutes each way,
  and a rover to relay-orbiter to Earth chain with 5% packet loss each way on a 4-minute
  link. Long light times are built from stacked netem stages (netem caps one delay).
- **Real orbits** (`constellation/orbits.mjs`, `orbits-run.mjs`). Public Starlink elements
  propagated with SGP4; links and ground visibility from geometry each minute. Every
  bundle verifies at 4,032 and 9,732 satellites. New dependency: satellite.js (MIT).
- **Per-hop payments on Teranode** (`constellation/teranode-run.mjs`). On a private
  regtest chain, one transaction per batch receipt pays the relaying satellite and commits
  the receipt: 30,502 confirmed; 100 of 100 sampled bundles proven custodied and paid at
  every hop from the chain alone; one Merkle root per minute as the low-cost alternative.

### Fixed

- **Ground demo** now includes a pass silent at both stations, so the shared-silence
  branch of pass comparison runs in the demo, not only in the tests. Pointed out by Sunnie.
- **ION runs**: each ION node now gets a private `/dev/shm`, since ION keeps named
  semaphores there and two nodes could otherwise interfere.

## 2026-09-29

### Added

- **Pass comparison across stations** (`ground/`). When two stations' schedules cover
  the same pass, their signed pass reports are compared: silence at both is recorded as
  shared silence, and silence at one station while the other received data locates the
  gap at the silent station. Suggested by Sunnie, with thanks for the close read.
- **NASA cFS application** (`flight/cfs/`, `make cfs`). The onboard signer as a standard
  cFS app: self-test at boot, commanded signing over the software bus, records identical
  to the published test vectors.
- **Aalyria Hardy interop** (`hardy/`, `make hardy`). Custody payload held by Hardy's
  time-variant routing across a scheduled gap, attached through Hardy's gRPC APIs. The
  contact-plan compiler now emits Hardy TVR plans (`--hardy`).
- **Ground station pilot plan** (`ground/PILOT.md`).
- **Onboard signing in C** (`flight/`, `make flight`). TweetNaCl Ed25519, byte-identical
  to the test vectors, about 11 KB of code on an ARM Cortex-M4.
- **Mixed-implementation chain** (`mix/`, `make mix`). uD3TN to NASA HDTN to uD3TN over
  TCPCLv3, held across a scheduled gap.
- **JPL ION interop** (`ion/`, `make ion`). Contact graph routing held the payload
  across a scheduled gap.
- **Ground-side pilot kit** (`ground/`). Station-signed ledgers from received files,
  pass reports with gap records for silent passes, a sealed ledger root, and
  cross-station corroboration.
- **Real Earth-Moon light time** (`make spike-moon`). Per-link netem delays with a
  1.3-second Earth link and a 20-second blackout.
- **Benchmarks** (`bench/`). Signing, hashing and custody overhead by chunk size.
