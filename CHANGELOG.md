# Changelog

## 2026-10-18

### Added

- **Paid receipts on public networks** (`constellation/ttn-run.mjs`). Teratestnet through
  Arcade: 30,502 paid receipts and 11 anchors mined, 30,513 merkle proofs matching headers,
  100 of 100 bundles proven (`constellation/TTN-RESULTS.md`). `--network=mainnet` runs the
  same flow on Bitcoin BSV mainnet through ARC at the broadcaster's live fee rate, with its
  own key, state and results, and refuses to send without `--spend-real-bsv`.
- **Run ledger and records** (`constellation/RUNS.md`, `constellation/runs/`): every payment
  run on regtest, teratestnet and mainnet, with per-run transaction records (receipt id, relay,
  paying transaction and output; no keys), the sweeps, and what has not yet run live.
- **Bitcoin BSV mainnet run** (`constellation/MAIN-RESULTS.md`): the same 30,502 paid receipts
  and 11 anchors mined through ARC, 30,513 merkle proofs matching headers whose proof of work
  was verified, 100 of 100 bundles proven custodied and paid at every hop. 897,665 sats in fees;
  the 3,050,200 sats paid to satellites can be swept back.
- **Several broadcasters** (`--broadcast=<url,...>`; mainnet default GorillaPool ARC, BSVA's
  mainnet Arcade and WhatsOnChain): the first must accept, the rest are best effort, and each
  acceptance is counted. `--rebroadcast` rebuilds a run's signed transactions (deterministic;
  checked against all 30,544 txids of the mainnet run) and resends any not yet mined, with no
  new payments. Built after the mainnet run's last 4,605 transactions waited a block.
- **Batch payments** (`--batch=N`): one transaction pays N relaying satellites, output *i*
  for receipt *i*, with the N receipt ids in one OP_RETURN. One fan-out gives each batch its
  own input, so every batch depends on a single parent. The first version chained batches
  (each spending the last one's change): on teratestnet 15,000 payments went out in 155
  transactions in 20 seconds, about 750 payments per second against about 80 before, and all
  15,000 were mined with 100 of 100 bundles proven, but some nodes saw children before parents
  and the tail waited for rebroadcast. The single-parent version then ran live on mainnet: 300
  payments in 5 transactions through three broadcasters, all accepted and mined in the next block.
- **Fresh payout address per payment** (`--payout=per-payment`, now the default; per-node
  remains for earlier runs and is recorded in their state).
- **SPV header check** in `--confirm`: each block header is rebuilt from its fields and must
  hash to the block hash and meet its own difficulty target before its merkle root is used.
- **Sweep** (`constellation/sweep.mjs`): collects the satellites' payments back to the funding
  address, using the run's own state (no address scanning), after checking a sample of payout
  outputs on chain against the derived keys. Live on teratestnet; checked against mainnet.

### Fixed

- **BIB over the primary block follows RFC 9173 erratum 9192** (`transport/bpv7/bpsec.mjs`). The
  published Appendix A.3 vector wraps the primary block in a byte string inside the MAC input;
  RFC 9172 section 4 forbids that, and erratum 9192 (reported by Rick Taylor, 2026-09-28)
  corrects it. Signing now emits the bare form and reproduces the erratum's corrected vector byte
  for byte; verification tries it first and falls back to the published A.3 form during the
  transition (reported as `a3PrimaryFallback`). Payload and other targets are unchanged.

- **Payout keys are derived under a secret from the funding key** (`constellation/payout.mjs`).
  They were derived from a public formula, which on mainnet would let anyone who read the
  code spend the satellites' payments.

- **BPSec beside block 224** (`transport/bpv7/bpsec.mjs`, RESULTS section 4). BIB-HMAC-SHA2
  (RFC 9173) build and verify, checked against the RFC's Appendix A vectors, with AES key
  unwrap (RFC 3394) for BIBs that carry a wrapped key. Live: a payload BIB through uD3TN,
  HDTN, ION and Hardy verifies before and after receipts are appended
  (`make bpv7-bpsec-all`); JPL ION with Mbed TLS accepts our BIB and refuses a wrong key
  (`make bpv7-bpsec-ion`), and signs a BIB our code verifies (`make bpv7-bpsec-ion-source`).
  Found that ION's default build accepts any MAC (NULL crypto suites) and that ION builds
  its MAC input from the whole target block rather than RFC 9173's byte string, so
  `bpsec.mjs` has an opt-in `mode: "ion"`; the default stays RFC 9173.
- **Custody receipt version 2** (`transport/bpv7/receipt-v2.mjs`, `cose.mjs`, spec 2.2):
  CBOR payload signed as COSE_Sign1 (EdDSA), about 156 bytes instead of about 530, bound to
  the BPv7 bundle identity and a SHA-256 of the payload bytes held, so no custodian parses
  the payload; fragments defined. Version 1 unchanged. Live through all five paths
  (`RECEIPT=2`, RESULTS section 6). Internet-Draft revision
  `ietf/draft-bsvkey-dtn-custody-receipt-block-01` (not submitted).
- **Transit-gap audit on uD3TN** (`make bpv7-block-prevnode`): stock uD3TN adds no
  Previous Node block (compile-time switch, off by default), so the audit could not name
  it; `r2/Dockerfile.prevnode` builds it with the switch on, and the uD3TN path now reports
  its gap (last unsigned `dtn://relayb.dtn/`) for both receipt versions.
- **Two implementations in one path** (`make bpv7-block-mix`): uD3TN then NASA HDTN, held
  across a gap; block 224 byte-identical, chain and payload BIB verify. Every live check
  now also prints the transit-gap audit using the stack's Previous Node block (RESULTS
  section 5).
- **One custody block per bundle.** A bundle carrying two blocks of type 224 is refused
  (`custody_block_malformed`).
- **Internet-Draft** `ietf/draft-bsvkey-dtn-custody-receipt-block-00` (xml, txt, html):
  the Custody Receipt Block as an Experimental specification. Not submitted.

- **Uncustodied transit gaps** (`auditCustodyChain`, `auditBundleCustody`, spec 2.1).
  When a route crosses plain BPv7 forwarders that do not sign, the destination reports
  each unsigned stretch as a gap `{afterHop, beforeHop, lastUnsigned}`, taken from the
  receipts and the Previous Node block. Receipts that are present are still checked
  strictly against pinned keys; a missing receipt is reported, never inferred. The strict
  pinned-route check (`verifyBundleCustody`) is unchanged.

### Changed

- **Later custodians no longer parse the payload.** Only the first custodian reads the
  payload to learn the ids; every later one copies `payloadId` and `bundleId` from the
  first receipt in block 224. The destination still derives `bundleId` from the payload,
  so a false id cannot pass. Wire format unchanged.
- **Terminology.** Spec section 2 now defines a custody receipt and states that these are
  not BPv7 administrative records and do not use or replace BIBE custody signalling.
  Living docs say "receipt" and "optional agent beside the bundle protocol agent" instead
  of "application-layer". Wire names (`custody/1`, block 224) and dated results files are
  unchanged.

## 2026-10-15

### Changed

- **Custody Receipt Block moved from type 193 to 224.** JPL ION assigns 192 to 197 to its
  own blocks and parses 193 as its QoS block: a bundle carrying our block as 193 was
  dropped by ION as malformed. 224 is clear of every stack tested.

### Added

- **The block through NASA HDTN, JPL ION and Aalyria Hardy** (`make bpv7-block-hdtn`,
  `-ion`, `-hardy`, or `bpv7-block-all` for all four stacks). Each one holds the bundle
  across a scheduled gap, adds its own standard blocks (Previous Node; ION also Bundle
  Age), and delivers our block byte-identical; the two-hop chain verifies every time.
  Raw bundles go in and out over HDTN STCP, the ION UDP convergence layer and Hardy's
  gRPC convergence-layer API (`transport/bpv7/interop/cl.mjs`, `hardy-cla.mjs`).

## 2026-10-14

### Added

- **Custody Receipt Block** (`transport/bpv7/`). The custody chain can now travel inside
  the BPv7 bundle it describes, as a BPv7 extension block (now type 224, see 2026-10-15),
  instead of as separate bundles to a `/custody` endpoint. Each custodian appends its
  signed `custody/1` record; nodes that do not know the block keep it and forward it
  unchanged. Includes a dependency-free BPv7 codec (RFC 9171 primary and canonical
  blocks, EIDs, CRC-16/X-25 and CRC-32C) and reads the previous hop from the standard
  Previous Node block when one is present.
- **Checked against uD3TN two ways.** pyd3tn (uD3TN's own BPv7 library) re-encodes our
  bundles byte for byte and we decode its bundles; and a live run (`make bpv7-block`)
  passes the bundle through two real uD3TN nodes, one holding it across a contact gap:
  the block arrives byte-identical and the two-hop chain verifies.

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
