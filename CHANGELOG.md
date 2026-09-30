# Changelog

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
