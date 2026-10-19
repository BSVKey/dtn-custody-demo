# What the Custody Receipt Block costs a high-throughput operator

The question this page answers: if a node signs custody receipts
(draft-bsvkey-dtn-custody-receipt-block-01, BPv7 extension block 224), how many bytes,
how much CPU and how much latency does that add at real link rates? It also answers the
scaling objection to per-hop accountability: per-bundle receipts do not scale to
high-rate links, but batched receipts (one signature per node per contact) do.

Every number below comes from a run of `bench/overhead.mjs` and `bench/overhead.c` on
the machine described here, on 2026-10-18 (US Central). Figures marked "derived" are
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
whole tree when the batch closes. The *streaming* builder (in `bench/overhead.mjs`) folds
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

`make overhead` runs the JS benchmark natively. `make overhead-c` builds
`bench/Dockerfile.overhead` and runs the C harness (TweetNaCl and libsodium builds) and
the JS benchmark in a Linux container. `make overhead-arm64` runs the same image built for
linux/arm64 under QEMU user-mode emulation (Docker binfmt), with the largest batch capped at
100,000 leaves to keep the run short. `--json file` writes the raw measurements. The raw
outputs of the runs on this page are committed next to the script:
`bench/overhead-x86-win.md` and `.json` (native), `bench/overhead-x86-linux.md`
(container, including the C results) and `bench/overhead-arm64-qemu.md` (emulated).

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
- **Not covered:** fragments, link loss and retransmission, contact-plan effects, storage
  I/O, and the cost of carrying batch receipts to the verifier.

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
verification-flood concern raised for per-bundle receipts. So the operator's cost is one
signature per contact, off the forwarding path, plus hashing they can size to their link.
