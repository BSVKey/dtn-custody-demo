# What the Custody Receipt Block costs a high-throughput operator

The question this page answers: if a node signs custody receipts
(draft-bsvkey-dtn-custody-receipt-block-01, BPv7 extension block 224), how many bytes,
how much CPU and how much latency does that add at real link rates? It also answers the
scaling objection to per-hop accountability: per-bundle receipts do not scale to
high-rate links, but batched receipts (one signature per node per contact) do.

It also measures the time a custodian adds before it can forward a bundle, before and after a
fast path that keeps the -01 wire format (section "Latency before forwarding"), and runs
both receipt modes across optical inter-satellite links modeled on public optical ISL
parameters (section "Optical inter-satellite links").

Every number below comes from a run of `bench/overhead.mjs`, `bench/overhead.c`,
`bench/latency.mjs` or `constellation/optical-isl.mjs` on the machine described here, on
2026-10-18 (US Central). Figures marked "derived" are
measured costs multiplied out by the arithmetic stated next to them. Nothing was run on
flight hardware.

## The two modes measured

**Per-bundle receipts (draft -01 as written).** Each custodian appends one COSE_Sign1
(EdDSA, Ed25519) receipt to block 224 of every bundle it holds. The receipt names the
bundle identity and the SHA-256 of the payload bytes held. Measured with the repository's
own `stampBundleV2` and `verifyBundleV2` (`transport/bpv7/receipt-v2.mjs`, `cose.mjs`) on
real encoded bundles.

**Batched receipts.** A node folds each bundle it takes custody of into a Merkle tree
and, when the batch window closes (end of contact, or every second on a continuous
link), signs one COSE_Sign1 over the root, count, window and hops. Nothing is added to
the bundles and nothing is signed on the forwarding path. Any one bundle is later proven
by the batch receipt plus an inclusion proof. Two leaf rules were measured:

- *content-bound*: leaf = SHA-256(0x00 || CBOR [bundle identity, SHA-256(payload)]),
  which hashes every payload byte;
- *identity-bound*: leaf = SHA-256(0x00 || CBOR [bundle identity]), which binds custody of
  the bundle identity but not its bytes.

Draft -01 lists batching as an open issue (section 8): how a batch receipt is carried is
not yet specified. The batch receipt here is a COSE_Sign1 over a CBOR map with the same
fields as the reference `custody-batch/1` record (`agent/lib/batch.mjs`), built from the
repository's `cbor.mjs` and `cose.mjs`. It is the benchmark's encoding, not a specified one.

Two tree builders were measured. The *reference* builder (`agent/lib/merkle.mjs`) builds the
whole tree when the batch closes. The *streaming* builder (in `bench/overhead.mjs`; the same algorithm is now
`agent/lib/stream-merkle.mjs`, with tests and inclusion proofs) folds
each leaf in as the bundle arrives, so closing costs log2(N) hashes and one signature. The
streaming builder produces the same root as the reference builder; the script checks this
at 8 tree sizes (1 to 4,097 leaves) before it measures anything.

## Machine

| | |
|---|---|
| CPU | AMD Ryzen 5 7600, 6 cores, 12 threads, 3.8 GHz base |
| Memory | 16 GB DDR5-4800 |
| OS | Windows 11 Home 10.0.26200 |
| Node (native run) | v24.14.1, win32 x64 |
| Linux container | Docker 28.4.0 on WSL2 (kernel 6.6.87.2), Debian bookworm, Node v20.20.2, gcc 12.2.0, libsodium 1.0.18 |
| C Ed25519 | TweetNaCl 20140427 (the flight signer in `flight/`, pinned by SHA-256) and libsodium 1.0.18 |
| C SHA-256 | `flight/sha256.c` (portable C, no SHA CPU extensions) |
| Background load | a Teranode test stack was running in Docker during all runs (about half of one core in total) |

All measurements are single-threaded.

## Commands

```bash
node bench/overhead.mjs
```

```bash
make overhead-c
```

```bash
make overhead-arm64
```

```bash
node bench/latency.mjs
```

```bash
node constellation/optical-isl.mjs --class 10G --acq 30
```

`make overhead` runs the JS benchmark natively. `make overhead-c` builds
`bench/Dockerfile.overhead` and runs the C harness (TweetNaCl and libsodium builds) and
the JS benchmark in a Linux container. `make overhead-arm64` runs the same image built for
linux/arm64 under QEMU user-mode emulation (Docker binfmt), with the largest batch capped at
100,000 leaves to keep the run short. `--json file` writes the raw measurements. The raw
outputs of the runs on this page are committed next to the script:
`bench/overhead-x86-win.md` and `.json` (native), `bench/overhead-x86-linux.md`
(container, including the C results), `bench/overhead-arm64-qemu.md` (emulated),
`bench/latency-x86-win.md` and `.json` (latency), and `constellation/optical-runs/` (one
`.md` and `.json` per optical run). For the optical script, `--class` is 2.5G, 10G or 100G
and `--acq` is the cross-plane acquisition time in seconds.

## Results (x86-64 native run unless stated)

### Signing, verification and hashing

| Operation | Implementation | Per second, one core |
|---|---|---|
| Ed25519 sign, receipt COSE_Sign1 (96 B payload) | Node (OpenSSL) | 28,891 |
| Ed25519 verify, receipt COSE_Sign1 (includes importing the pinned key each time) | Node (OpenSSL) | 10,759 |
| Ed25519 sign, 128 B message | TweetNaCl (flight signer) | 863 |
| Ed25519 verify, 128 B message | TweetNaCl | 493 |
| Ed25519 sign, 128 B message | libsodium | 77,009 |
| Ed25519 verify, 128 B message | libsodium | 27,498 |
| SHA-256, 1 KiB / 64 KiB / 1 MiB | Node (OpenSSL) | 609 / 2,311 / 2,105 MB/s |
| SHA-256, 1 KiB / 64 KiB / 1 MiB | `flight/sha256.c` | 328 / 385 / 398 MB/s |
| Batch bookkeeping per bundle (one leaf hash + one node hash) | `flight/sha256.c` | 856,243 bundles |

The C figures are from the Linux container run on the same CPU. The second run of the JS
benchmark (Linux container, Node 20) gave 33,561 signs and 6,269 verifies per second: expect
up to about 40% run-to-run and platform spread on these figures.

### Bytes on the wire

| | Size |
|---|---|
| Block 224 with the first per-bundle receipt | 168 B |
| Each further custodian's receipt | 156 B |
| One batch receipt (COSE_Sign1, CBOR) | 169 B |
| The same batch as `custody-batch/1` canonical JSON | 470 B |
| Inclusion proof for one bundle in a batch of 1,000 / 1,000,000 | 320 B / 640 B |

### Receipt bytes per GB of payload, one custodian hop (derived)

GB = 10^9 payload bytes. Per-bundle: (10^9 / bundle size) x 168 B. Batch: one 169 B
receipt per window, so (10^9 / bytes carried per window) x 169 B, independent of bundle size.

| Bundle size | Per-bundle receipts | Batch, 1 s window, 100 Mbps | 1 Gbps | 10 Gbps | 100 Gbps | Batch, 60 s contact, 100 Mbps | 100 Gbps |
|---|---|---|---|---|---|---|---|
| 1 KiB | 164,062,500 B (16.4%) | 13,520 B | 1,352 B | 135 B | 13.5 B | 225 B | 0.23 B |
| 64 KiB | 2,563,477 B (0.26%) | 13,520 B | 1,352 B | 135 B | 13.5 B | 225 B | 0.23 B |
| 1 MiB | 160,217 B (0.016%) | 13,520 B | 1,352 B | 135 B | 13.5 B | 225 B | 0.23 B |

Each further custodian hop adds another 156 B per bundle in per-bundle mode, and one more
169 B receipt per window in batch mode. Batch mode puts nothing in the bundles; the receipts
travel separately (for example one administrative bundle per window).

### CPU to keep up with the link, percent of one core (derived)

Bundles per second at the link rate, times the measured per-bundle cost on one core.
Over 100% means more than one core. "Stamp" is the full reference path on raw bundle
bytes (decode, hash the payload, sign, re-encode); "hash + sign" is the cryptographic work
alone; "verifier" checks one custodian's receipt on every bundle. Batch columns use the
streaming builder (leaf + fold per bundle, one signature per 1 s window).

| Link | Bundle | Bundles/s | Per-bundle: stamp | Per-bundle: hash + sign | Per-bundle: verifier | Batch, content-bound | Batch, identity-bound |
|---|---|---|---|---|---|---|---|
| 100 Mbps | 1 KiB | 12,207 | 92.7% | 44.3% | 139% | 7.57% | 4.73% |
| 100 Mbps | 64 KiB | 191 | 14.1% | 1.20% | 8.83% | 0.63% | 0.077% |
| 100 Mbps | 1 MiB | 12 | 11.3% | 0.64% | 5.10% | 0.60% | 0.0081% |
| 1 Gbps | 1 KiB | 122,070 | 927% | 443% | 1,392% | 75.7% | 47.3% |
| 1 Gbps | 64 KiB | 1,907 | 141% | 12.0% | 88.3% | 6.28% | 0.74% |
| 1 Gbps | 1 MiB | 119 | 113% | 6.35% | 51.0% | 5.99% | 0.050% |
| 10 Gbps | 1 KiB | 1,220,703 | 9,274% | 4,430% | 13,917% | 757% | 473% |
| 10 Gbps | 64 KiB | 19,073 | 1,415% | 120% | 883% | 62.7% | 7.40% |
| 10 Gbps | 1 MiB | 1,192 | 1,130% | 63.5% | 510% | 59.9% | 0.47% |
| 100 Gbps | 1 KiB | 12,207,031 | 92,739% | 44,303% | 139,175% | 7,571% | 4,731% |
| 100 Gbps | 64 KiB | 190,735 | 14,145% | 1,201% | 8,829% | 627% | 73.9% |
| 100 Gbps | 1 MiB | 11,921 | 11,298% | 635% | 5,103% | 599% | 4.62% |

How to read the hard rows:

- **Content-bound batches at 10 and 100 Gbps** are almost entirely SHA-256 of the payload:
  100 Gbps is 12.5 GB/s against about 2.1 GB/s per core, so about six cores just to hash.
  Per-bundle receipts pay that same hash plus a signature per bundle.
- **1 KiB bundles at 10 Gbps and up** are a bundle-rate problem (1.2 and 12.2 million bundles
  per second). The JS reference spends about 4 us of bookkeeping per bundle; the same leaf
  and node hashes in C take about 1.2 us (856,243 per second), or about 14 cores at 12.2
  million bundles per second. For scale, the JS reference takes 5.3 us just to decode a
  1 KiB bundle, which would be 64 cores at that rate before any custody work. Operators at
  that rate aggregate small bundles or process in parallel anyway.
- **Identity-bound batches at 1 MiB** cost under 5% of one core even at 100 Gbps.

### Latency (measured, or derived where marked)

| Link | Bundle | Per-bundle: added on the forwarding path, per bundle per hop | Batch: added on the forwarding path | Batch close, streaming | Batch close, reference rebuild, 1 s window | Batch close, reference rebuild, 60 s contact |
|---|---|---|---|---|---|---|
| 100 Mbps | 1 KiB | 89.4 us | 0 | 65.8 us | 25.8 ms | 1.63 s |
| 100 Mbps | 1 MiB | 9.49 ms | 0 | 47.2 us | 20.8 us | 1.25 ms |
| 1 Gbps | 64 KiB | 743 us | 0 | 65.8 us | 3.61 ms | 254 ms |
| 10 Gbps | 64 KiB | 742 us | 0 | 65.8 us | 40.3 ms | 2.54 s (derived) |
| 10 Gbps | 1 MiB | 9.48 ms | 0 | 57.2 us | 2.26 ms | 151 ms |
| 100 Gbps | 64 KiB | 742 us | 0 | 65.8 us | 424 ms | 25.4 s (derived) |
| 100 Gbps | 1 MiB | 9.48 ms | 0 | 65.8 us | 25.2 ms | 1.59 s |

The per-bundle figure is the reference stamp time plus the serialization time of the
added 168 B at the link rate; most of it is the JS decode and re-encode of the bundle,
and 1 MiB bundles take longest because the whole bundle is copied. Batch close times are
the per-leaf cost measured at the nearest batch size at or above the window's bundle count
(1,000 to 1,000,000 leaves measured); "derived" means the window holds more than 1,000,000
leaves and the per-leaf cost at 1,000,000 was multiplied out. The streaming close is
measured at the nearest size up to 1,000,000 leaves; above that it grows only with log2 N
(20 hashes at a million leaves, 30 at a billion). The full table for all 24 cases is in
`bench/overhead-x86-win.md`.

Batch close time is not forwarding latency. Bundles leave at line rate; the close only
decides when the receipt for the window exists. With the streaming builder that is under
0.1 ms after the window ends in every case measured.

## Latency before forwarding: before and after

The time a custodian adds between the last byte of a bundle arriving and the outgoing
bundle being ready for the convergence layer (`bench/latency.mjs`, medians, one core). The
reference `stampBundleV2` starts only once the whole bundle is in hand. It decodes every block,
checking every CRC including CRC-32C over the payload. Then it hashes the payload, signs, and
re-encodes every block, computing every CRC again. The fast path
(`transport/bpv7/fast-stamp.mjs`) applies four of the candidate changes:

1. **Hash incrementally.** SHA-256 and the payload CRC-32C run as each convergence-layer
   segment arrives, so both are ready when the last byte lands.
2. **Precompute.** The constant prefix of the COSE Sig_structure and the CBOR of the
   repeating receipt fields (this hop, previous hop) are encoded once.
3. **Splice.** The new block 224 is inserted before the payload. Every other block is forwarded
   as the exact bytes received: nothing is re-encoded and no other CRC is recomputed.
4. **Gathering write.** The bundle is handed over as a list of buffers; the payload is a view,
   not a copy.

The wire format is unchanged. For every case in `test/bpv7-fast-stamp.test.mjs`, the output
is byte-identical to `stampBundleV2`: the first and later custodians, a Previous Node block,
fragments, each CRC type, a subject, and a block filled to 64 receipts.

| Bundle | Before: `stampBundleV2` | Splice only (whole bundle in hand) | After: incremental, 1,472 B segments (UDP or LTP over a 1,500 B MTU) | After: incremental, 64 KiB segments (TCPCLv4) |
|---|---|---|---|---|
| 1 KiB | 52.7 us | 40.9 us | 39.6 us | 38.9 us |
| 64 KiB | 700 us | 332 us | 56.1 us (12.5x less) | 53.5 us (13.1x less) |
| 1 MiB | 10.06 ms | 4.99 ms | 126 us (80x less) | 163 us (62x less) |

The Ed25519 signature alone took 28.6 us in this run. That is the floor for any per-bundle
receipt, and most of what remains at 1 KiB. The 1 MiB "after" figures vary between runs:
an earlier run on the same machine (not saved) gave 57 to 60 us. Treat them as tens to
low hundreds of microseconds.

What was not changed, and why:

- **Signing while the convergence layer starts sending.** RFC 9171 section 4.1 makes the
  payload the last block, and block 224 precedes it, so only the bytes before block 224 can
  go out while the signature is computed. In this bundle that is the 39 B primary block:
  31 ns at 10 Gbps and 3 ns at 100 Gbps, against a 28.6 us signature. Not worth doing, and
  any real fix would need a different block order, which is a format change. See
  `docs/custody-receipt-02-proposals.md`.
- **Batched per-contact receipts.** These remove the signature from the forwarding path
  entirely (added latency 0), but how the batch receipt is carried is not in -01. They are
  written up as proposal 1 in `docs/custody-receipt-02-proposals.md`.

The incremental work is moved, not removed. The CPU per bundle, counting the work done while
the segments arrive, was 4.7 to 4.9 ms per MiB in this JavaScript code (about 220 MB/s). Most
of that is the byte-at-a-time CRC-32C, which Node does not provide natively. A BPA in C with
hardware CRC-32C would spend far less, but that was not measured here. So on one JS core this
path keeps up with about 1.7 Gbps of arriving payload, whether or not receipts are signed.

## Optical inter-satellite links (modeled on public optical ISL parameters)

`constellation/optical-isl.mjs` runs both receipt modes across optical crosslinks whose
rates and timings come from published standards. It does not model, and makes no claim
about, any operator's proprietary laser system.

**Sources modeled.**

- ESA, *ESA Specification for Terabit/s Optical Links (ESTOL)*, ESA-CSC-T-SP-0001, issue 3.1,
  24 June 2026, prepared by ESA, JAXA and their industries:
  - 2.5G IM/DD OOK, user net data rate up to 2.221 Gbps (ESTOL-OOK-41010);
  - 10G IM/DD OOK, 10.0 Gbps (ESTOL-OOK-43010);
  - 100G DP-QPSK, 99.5328 Gbps (ESTOL-HCO-31010);
  - PAT acquisition (warm start) shall be below 60 s and should be below 30 s
    (ESTOL-PAT-00030, -00040); re-acquisition below 10 s, repeated automatically until the
    scheduled link end (ESTOL-PAT-00050, -00060).
- ESTOL builds on the SDA *Optical Communications Terminal (OCT) Standard*, SDA 9100-001-09,
  version 4.0.0 (28 June 2024), and on CCSDS 141.11-O-1, *Optical high data rate (HDR)
  communication, 1064 nm*. The 2.5 Gbps class is the SDA OCT class. The OCT timing figures
  were taken through ESTOL's references to them, not read from the OCT document directly.
- A 2025 study of pointing, acquisition and tracking delays reports modeled LEO
  acquisition delays clustering around 50 seconds and calls sub-2-second setup optimistic
  (arXiv:2511.16063). The runs bracket that with 30 s and 60 s.
- DTN over these links: the convergence layer is modeled as reliable, as TCPCLv4 (RFC 9174)
  or LTP (RFC 5326) would be: a transmission cut by an outage is resent when the link
  returns. It is not run as real UDP, TCPCLv4 or LTP traffic.

**Scenario.** Custodians A and B are in plane 1, C and D in plane 2. B's cross-plane link to
C ends at the handoff, half-way through 600 s of traffic. B then waits for a new cross-plane
link to C2 to be acquired (30 s, or 60 s in the worst-case run). C2 is a relay that does not
run custody, so bundles routed through it must show a gap. Every link fades at random (on
average one fade per 120 s per link) and re-acquires in 2 to 10 s. Traffic is 1 MiB bundles
at 80% of the link rate. Every bundle is scheduled through the links. Every custodian folds
every bundle into a per-contact batch and signs one batch receipt when each contact ends.

A sample of 401 bundles is also carried as real BPv7 bytes, stamped at each custodian with
per-bundle receipts through the fast path. Custodian C tampers with one sampled bundle: it
changes the payload and recomputes the CRCs. At the ground, the sample is audited from block
224 (`verifyBundleV2`) and, separately, from the batch receipts plus inclusion proofs.

| | 2.5G, 30 s acquisition | 10G, 30 s | 10G, 60 s | 100G, 30 s |
|---|---|---|---|---|
| Bundles (1 MiB), all delivered | 127,086 | 572,204 | 572,204 | 5,695,312 |
| Routed through the unaware relay after the handoff | 63,646 | 286,563 | 286,563 | 2,852,218 |
| Fades during traffic / transmissions cut and resent | 21 / 117 | 21 / 474 | 15 / 469 | 21 / 4,576 |
| Held in custody at B across the handoff (peak) | 6,713 bundles, 7.04 GB | 30,224, 31.69 GB | 58,834, 61.69 GB | 300,803, 315.41 GB |
| End-to-end delay, median before the handoff / max overall | 2.23 s / 31.7 s | 2.21 s / 31.7 s | 0.50 s / 65.0 s | 2.21 s / 31.7 s |
| Batch receipts signed, total bytes | 20, 3,580 B | 20, 3,596 B | 14, 2,518 B | 20, 3,612 B |
| Per-bundle receipt bytes the same traffic would carry (block 224 at the last hop) | 70,897,920 B | 319,217,916 B | 319,217,916 B | 3,177,272,424 B |
| Batch close (root + sign), median / max | 111 / 5,890 us | 72 / 484 us | 96 / 424 us | 76 / 2,402 us |
| Per-bundle stamp after the last 64 KiB segment, median per hop | 95 us | 122 us | 108 us | 106 us |
| Per-bundle audit: complete / gap at the unaware relay / failed | 200 / 200 / 1 | 199 / 201 / 1 | 199 / 201 / 1 | 199 / 201 / 1 |
| Batch audit: complete / gap at the unaware relay / content changed | 200 / 200 / 1 | 199 / 201 / 1 | 199 / 201 / 1 | 199 / 201 / 1 |

What the runs show:

- **Custody survives the link events.** Every bundle was delivered across fades, cut
  transmissions and the cross-plane handoff. B held up to 315 GB in custody while the new
  100G link was acquired.
- **Both audits agree on every sampled bundle.** Bundles routed through the unaware relay
  show a gap at exactly that relay. The tampered bundle fails both audits: block 224 reports
  `payload_hash_mismatch` at the first custodian, and the earlier custodians' inclusion
  proofs fail in the batch audit. No batch receipt failed signature verification.
- **Batch receipts stay small.** About 20 receipts and 3.6 KB for the whole run at every
  rate, against 3.2 GB of per-bundle receipts for the same 100G traffic.
- **The handoff dominates delay, not custody.** End-to-end delay is set by acquisition time
  and by the backlog draining at the 20% spare capacity. The receipts add tens to a few
  hundred microseconds per hop in per-bundle mode and nothing in batch mode.

Limits of the model: one chain of five nodes, not a constellation; no propagation delay;
fades drawn at random, not from measured fade statistics; and the convergence layer is
modeled, not run. Unsampled bundles carry no payload bytes in the sim. Their payload hash
is a stand-in value, so only the sample exercises real bundle bytes. At 100G one bundle in 14,203 was
sampled, so per-bundle stamping was not run on every bundle; its cost per bundle is in the
tables above.

## Emulated ARM (aarch64 under QEMU, not flight hardware)

The same image built for linux/arm64 and run under QEMU user-mode emulation on the same
x86 desktop (`make overhead-arm64`). Emulation translates every instruction in software.
Emulated ARM was 4 to 32 times slower than the native runs, depending on the operation
(TweetNaCl signing 3.9 times, Node verification 32 times). These figures show that the
code builds and runs on aarch64. They are **not an estimate of flight or ARM server
hardware**, which must be measured on the target.

| Operation, aarch64 emulated | Per second, one emulated core |
|---|---|
| Ed25519 sign, Node COSE_Sign1 | 1,742 |
| Ed25519 verify, Node COSE_Sign1 | 341 |
| Ed25519 sign / verify, TweetNaCl (flight signer) | 224 / 118 |
| Ed25519 sign / verify, libsodium | 10,935 / 5,109 |
| SHA-256 1 MiB, Node / `flight/sha256.c` | 141 / 49 MB/s |
| Batch bookkeeping per bundle (leaf + node hash), C | 69,857 bundles |
| Batch close, streaming, 100,000 leaves (root + sign), Node | 0.87 ms |

Even emulated, the batch mode with identity-bound leaves keeps up with 1 Gbps of 1 MiB
bundles on under 1% of one emulated core (0.98%) and with 100 Gbps on 92%, and the
streaming close takes under 1 ms. Per-bundle receipts at 1 Gbps of 64 KiB bundles need
about 20 emulated cores for the stamp path (1,966%). Full tables: `bench/overhead-arm64-qemu.md`.

## Limits

- **One desktop core, then multiplied.** CPU percentages assume the work spreads evenly
  across cores. Per-bundle signing and batch folding are independent per bundle or per
  link, but no multi-core run was made.
- **Reference code, not an optimized BPA.** The JS stamp path decodes and re-encodes the
  whole bundle; a BPA that appends the block in place would not. The "hash + sign" column
  is the cryptographic floor of the per-bundle mode on this machine.
- **The pinned key is imported on every verify** (as `cose.mjs` does). A verifier that
  caches imported keys would verify faster; not measured.
- **Batch carriage is not specified** in draft -01, and the batch receipt encoding and the
  streaming tree are benchmark code. The streaming tree is checked against the reference
  tree at 8 sizes, not proven equal in general.
- **Inclusion proofs need the leaves.** To prove any one bundle later, a node keeps 32 bytes
  per bundle per window (derived: 23.4 GB per 60 s at 100 Gbps with 1 KiB bundles, 22.9 MB
  with 1 MiB bundles). A node that keeps only the root can attest the count and root of a
  window but cannot prove individual bundles.
- **Identity-bound leaves do not bind payload bytes.** They show which bundles a node took
  custody of, not that the bytes were unchanged; content-bound leaves do, at the cost of
  hashing every byte.
- **Flight hardware was not measured.** TweetNaCl, the flight signer, is chosen for size
  (about 12.3 KB on a Cortex-M4, `flight/RESULTS.md`) and is about 30 times slower to sign
  than OpenSSL on this CPU; at one signature per contact that does not matter, at one per
  bundle it does. The ARM figures above are emulated.
- **Not covered:** fragments in the rate benchmarks (the fast path is tested on them),
  measured link loss statistics (the optical runs use modeled fades), real convergence-layer
  traffic, contact-plan effects, storage I/O, and the cost of carrying batch receipts to the
  verifier.

## Conclusion

Signing every bundle at every hop does not scale: with 1 KiB bundles the receipts are 16%
of the data and the signing alone needs several cores per gigabit. Signing once per contact
does scale. A node signs one 169-byte receipt per contact or per second, off the forwarding
path, so bundles move at line rate and nothing is added to them. The receipt bytes fall to
about 1.4 KB per GB at 1 Gbps with one receipt per second, and well under one byte per GB on
a 100 Gbps link with one receipt per 60-second contact. The signature itself costs about
35 microseconds once per window. What remains is per-bundle bookkeeping, one or two small
hashes per bundle, and, if the operator wants the receipt to cover the bytes, a SHA-256 of
the payload. At 1 MiB bundles that costs under 5% of one core at 100 Gbps when the
identity is bound, and about six cores when every byte is hashed. A verifier also checks one
signature per node per contact instead of one per bundle per hop, which removes the
verification-flood concern raised for per-bundle receipts. Where an operator does want
per-bundle receipts as -01 specifies them, hashing as the bytes arrive and splicing the block
in cut the added time per hop from 10 ms to well under a millisecond for a 1 MiB bundle,
with the same bytes on the wire. On optical crosslinks modeled on public ESTOL and SDA OCT
parameters, both modes held custody through fades and a cross-plane handoff and found the
same gaps and the same tampering. Batch mode did it with about 20 signatures for the whole
run. So the operator's cost is one signature per contact, off the forwarding path, plus
hashing they can size to their link.
