# Changelog

## Unreleased

### Added

- **Offline key management** (`spec/KEY-RECORDS.md`, `transport/bpv7/keyring.mjs`): COSE-signed
  key and revocation records chaining to operator root keys, carried in a Key Record Block
  (type 225) and spread by custodians with ordinary traffic. Roles, validity windows,
  rotation, self-revocation, issuer compromise, and witnessed time: a stolen key cannot
  backdate a receipt past an honest witness. Receipt v2 gains optional field 8 (hop count,
  sizes unsigned gaps) and field 9 (digest of earlier receipts). `verifyBundleV2` takes a
  keyring. Live through uD3TN, HDTN, ION, Hardy and the mixed path with the destination
  holding only the root key (`make bpv7-keyring-all`, results section 9).

- **Voyager 1 at one light-day** (`voyager/`): the custody agent over a contact-window link
  model with Voyager 1's light time (23.8 h), 160 bps downlink and 16 bps uplink, and an
  illustrative DSN track plan with a missed track. Downlink science frame and uplink command
  load both verify chunk by chunk with full custody chains; Voyager's signed delivery receipt
  comes back down. Simulated in virtual time. `make voyager`, `voyager/RESULTS.md`.
- **Voyager 2, signed schedules, bit errors** (`voyager/`): missions in `missions.json`
  (Voyager 2 commandable only from DSS-43); each schedule is a contact plan compiled to ION and
  HDTN and signed as `dtn.contact-plan/1`, the only source of link windows, with gap records
  checked against it; per-bit errors with NACK-driven resends over the reverse link
  (`node voyager/sweep.mjs`, 20 seeds per rate).
- **JPL ION at Voyager's data rates** (`make ion-voyager`, `voyager/ION-RESULTS.md`): LTP over
  UDP at 160 bps down / 16 bps up, 240 s light time, every chunk and custody handoff verified.
  `mars/run-mars.sh` gains optional `RATE_DOWN_BPS`, `RATE_UP_BPS`, `SEG`, `QTIME`, `PACE`
  and timeouts (defaults unchanged); `ion/prepare.mjs` takes `PAYLOAD_REPEAT` and
  `CHUNK_SIZE`. Open: LTP segments under about 575 bytes did not deliver in our setup.
- **Hop Count check** (`transport/bpv7/RESULTS.md` section 8): uD3TN, HDTN, ION and Hardy each
  add 1 per node; basis for gap sizing in draft -02 (proposal 4).

## 0.4.1

The npm package gains the payout fix below, `agent/lib/arc.mjs`, and the per-bundle times in
batch receipts listed under 2026-10-19 (optional; batches without them are unchanged). The
radio work below is in the repository only, not in the package.

### Fixed

- **Relay payouts could be recorded as paid when they were never sent** (`relief/kit/payout.mjs`).
  ARC can answer HTTP 200 for a transaction the network will never mine (`SEEN_IN_ORPHAN_MEMPOOL`,
  `DOUBLE_SPEND_ATTEMPTED`, `REJECTED`), and any 2xx, or any body containing "known" (including
  "unknown"), counted as sent. The broadcast now goes through `broadcastPayout()`, which reads
  the `txStatus` (`agent/lib/arc.mjs`) and appends to `payouts.jsonl` only when ARC accepted the
  payout; otherwise the CLI says NOT SENT with the reason and the handoffs stay owed. The same
  check now judges broadcasts in `constellation/ttn-run.mjs` and the radio gateway, faucet and
  phone page.

### Added

- **Pay over radio** (`radio/`): offline-signed BSV payments (EF, or BEEF) in frames that fit a
  Meshtastic LoRa packet, NACK-driven resend of missing frames, offline signature and amount
  checks, and a receipt signed by the gateway and verified against a pinned key. Simulated lossy
  link with LoRa time on air (`node radio/run-demo.mjs`, `make radio`), and a Meshtastic USB
  bridge plus `radio/cli.mjs` for real radios, over USB (`--port`) or TCP (`--host`). Passed
  through real Meshtastic firmware (meshtasticd 2.7.26, `radio/meshtasticd/run-sim.sh`); not yet
  run on two physical radios. The gateway broadcasts
  only with `--spend-real-bsv`.
- **Phone handoff page** (`radio/handoff/index.html`): one self-contained offline page to hand a
  signed payment over by QR code, by sound (ggwave, about 14 to 26 s) or by a text to a gateway,
  check it offline on the receiving phone, keep it in an outbox, and check the gateway's signed
  receipt. Built by `node radio/handoff/build.mjs` from the same `radio/lib` code the gateway
  runs; third-party licences ship with it.
- **Nearby (WebRTC)** on the phone page: link two phones on the same Wi-Fi or hotspot by
  swapping two QR codes (the offer also opens from the camera app), then send payments directly,
  checked on arrival. Local network only (no STUN/TURN), compact codes with public addresses
  removed. Tested between two Chrome instances; not yet between two real phones.
- **Faucet** (`radio/faucet/`): choose a coin size and a count or total; one fan-out transaction
  makes the coins; announce them over sound, walkie-talkie, AM/FM, LoRa, SMS or QR. Claims mode
  pays one coin per sender, address or device key against `BSV1 CLAIM <address>` texts, with a
  signed receipt, a ledger that survives restarts, and one-at-a-time payouts. Bearer mode
  broadcasts coin keys for offline sweeps. Refuses coins too small to claim and funding too small
  to make them. The phone page turns heard announcements into a claim text and sweeps bearer
  coins. Run on mainnet in bearer mode (2026-10-20): announced by sound, claimed from an iPhone.
- **Walkie-talkie, AM, FM and phone-call audio** (`radio/lib/channels.mjs`, `radio/audio/`): channel
  profiles that pick the ggwave tones each channel keeps (dual tone for walkie-talkies, AM and
  calls), `make-wav.mjs` to play a payment into a radio or call and `decode-wav.mjs` to decode a
  recording. Tested in simulation only (band limits and noise), not on real equipment. The phone
  page gains a walkie-talkie setting.
- **Amateur profile** (`radio/lib/ham.mjs`): coded and locked, not used. Requires a callsign,
  identifies at least every 9.5 minutes, and refuses payments, receipts and encoded data.
- **SMS gateway** (`radio/sms/`): payments as GSM-7-safe texts (one text, or parts for short
  satellite texts), checked offline and answered with the signed receipt; Twilio and SMS Gateway
  for Android webhooks with signature checks. Tested with simulated requests; not yet run on a
  live number.

## 0.4.0

### Added

- **Lost-chunk resend** (`relief/kit`): a hub whose report stays incomplete asks the clinic,
  in a request signed by the hub and routed back the way the report came, to resend exactly
  the missing chunks or manifest; backs off and stops after `maxResends`. Over real µD3TN it
  recovered every chunk lost to a courier app crash in three of three runs
  (`relief/realnet/resend-crash.sh`).
- **Device key revocation**: `provision.mjs --revoke <node>` issues a replacement key and
  records the old one as revoked; a running hub reloads its config and refuses anything signed
  with the old key from then on (`key_revoked`), by its own clock, while earlier work still
  counts. The dashboard shows resend requests and revoked devices.
- **The field pilot kit in the npm package**: `@bsvkey/dtn-custody/relief-kit/*`, with
  `@bsv/sdk` as an optional peer dependency for payouts. The default install still has no
  runtime dependencies.

### Fixed

- The kit's command-line tools now run on Windows and through symlinks (the entry check
  compared a URL path with a file path).

## 2026-10-19

### Added

- **Optical mode for the constellation run** (`node constellation/run.mjs --links=optical
  [--rate=10G|100G] [--acq=10]`): crosslinks modeled on public optical ISL parameters (ESA
  ESTOL v3.1 rates and re-acquisition, SDA OCT-class range), one batch per node per contact,
  and a report of re-acquisitions, waits and link lengths. `--write` writes
  `constellation/OPTICAL-RESULTS.md`.
- **Per-bundle times in batch receipts** (`agent/lib/batch.mjs`, optional `times`): each leaf
  commits "id@time", the record is signed `leafTimes: true`, and the inclusion proof carries
  the time, which `verifyPath` checks against the window and uses as the hop's exact time.
  Batches without it are unchanged.

### Fixed

- **Looping routes over long-open contacts** failed verification at scale: under 30%
  cross-link failure with optical contacts, 2,275 of 10,000 bundles could not be ordered from
  windows alone. Optical batches now commit per-bundle times, a bundle crossing a link twice
  in one contact starts a new batch, `assemblePath` searches (bounded) for a time-consistent
  order when the earliest-start walk fails, and the constellation verifier's hop cap is 512
  (routes there reached 314 hops). 10,000 of 10,000 now verify; RF output is unchanged.
  `docs/custody-receipt-02-proposals.md` updated: batch leaves need per-bundle times when
  contacts stay open.

- **Relief field pilot kit** (`relief/kit/`): `provision.mjs` (keys and per-device configs,
  refuses to overwrite a deployment), `node.mjs` (clinic outbox, relay custody, hub verify,
  decrypt, frame log replayed on restart), a hub dashboard, `payout.mjs` (BSV relay payouts with
  an OP_RETURN commitment to the paid handoffs, never paying a handoff twice, `--spend-real-bsv`
  to broadcast), `run-local.sh` over five real µD3TN nodes, and a Docker Compose demo.
- **Real-network relief runs** (`relief/realnet/`): five Linux network namespaces, real loss,
  rate limits, delay and a 100%-loss satellite blackout; in five runs (TCPCLv3 and mtcp links,
  blackouts of 50 s and 120 s) every file verified and byte-identical.
- **Regional-scale relief run** (`relief/scale/`): 480 clinics, 48 couriers, 16 relays over three
  days with changing routes and long outages; batch receipts, payouts for proven handoffs, every
  undelivered bundle located at its last custodian, six attacks each contained.
- **Disaster-relief walk-through** (`relief/`): clinic reports encrypted to a district hub
  (X25519, HKDF, AES-256-GCM), carried by courier and a satellite terminal with a 70-minute
  power cut; per-chunk and per-hop verification, a gap record, payouts for proven custody only,
  and an impostor relay refused. Tested in the suite and run in CI.
- **Quickstart for integrators** (`docs/QUICKSTART.md`, `examples/quickstart.mjs`, `index.mjs`): one
  import for the whole agent API (`npm install @bsvkey/dtn-custody`), a 40-line
  source to relays to destination example, the refusal rules, and where to plug in a real
  network. Tested in the suite and run in CI.
- **Signed TREB hop-records** (`transport/bpv7/treb-signed.mjs`): a proposed optional profile for
  the Traceroute Extension Block (draft-koo-dtn-traceroute-eb-02). The 7-field hop-record is
  unchanged; an optional eighth element is a COSE_Sign1 with a detached payload, bound to the
  bundle identity and payload hash through external AAD. `cose.mjs` gains detached payloads and
  external AAD.
- **Inter-domain accountability framework** (`ietf/draft-bsvkey-dtn-interdomain-accountability-00`,
  not submitted): how the DTN Peering Protocol, TREB, custody receipts, SBAM and BPSec COSE fit
  together, with proposals for custodian keys endorsed by a domain's DPP key, a receipt-policy
  route attribute, checking ad_path against the evidence, signed hop-records and Hop Count gap sizing.
- **Per-hop block case study** (`docs/per-hop-block-case-study.md`) for the working group's
  per-hop block discussion, and a **CCSDS route note** (`docs/ccsds-path.md`).
- **LunaNet profile** (`docs/lunanet-profile.md`, `lunar/`): how block 224 maps onto the DTN
  services in NASA's LunaNet Interoperability Specification v5 (BPv7, TCPCL/UDPCL/LTPCL/EPPCL,
  BPSec, SANA/IANA registration), with what is and is not tested. `node lunar/run.mjs` runs
  three providers (lander, relay orbiter, Earth ground station) through a non-signing surface
  relay, a 47-minute far-side occultation and the Earth-Moon light time, with a payload BIB.
- **Light-time audit** (`auditLightTime` in `lunar/lunanet.mjs`): flags a receipt claiming a
  custodian received a bundle sooner than light could carry it from the previous custodian,
  so a backdated receipt is caught even when its signature is genuine. Uses only the times
  every receipt already carries; no format change. 4 tests.
- **Block 224 over LTP** (`transport/bpv7/interop/ion-ltp-run.sh`, `make bpv7-block-ion-ltp`):
  receipt version 2 and a payload BIB cross two JPL ION nodes joined by LTP over UDP, with the
  Earth-Moon light time (1,282 ms each way) on the link. The block arrives byte-identical, the
  BIB verifies, and the unsigned ION stretch is reported as a gap.
- **Lunar ephemeris** (`lunar/ephemeris.mjs`): the light-time audit's Earth-Moon floor now
  comes from the Moon's distance at the moment of the contact (Meeus, chapter 47; reproduces
  his worked example to 0.1 km), less the Earth's radius and the orbiter's orbit radius.
  3 tests.

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
