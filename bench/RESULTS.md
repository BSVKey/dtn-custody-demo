# Custody layer: performance and overhead

Measured 2026-09-29 on AMD Ryzen 5 7600 6-Core Processor, 12 threads, Node v24.14.1, win32 x64, single thread.
Reproduce: `node bench/bench.mjs`. Figures are for this machine; flight processors will be slower.

## Signing and verification

| Operation | Per second | Microseconds each |
|---|---|---|
| Ed25519 sign (one per custody receipt) | 34,933 | 28.6 |
| Ed25519 verify | 11,742 | 85.2 |
| Create a full custody receipt (canonical JSON, SHA-256, sign) | 32,152 | 31.1 |
| Verify a full custody receipt | 10,440 | 95.8 |

## Chunk fingerprinting (SHA-256 leaf hash)

| Chunk size | Hashes per second | Throughput |
|---|---|---|
| 1 KiB | 379,052 | 388 MB/s |
| 64 KiB | 11,767 | 771 MB/s |
| 1,024 KiB | 1,035 | 1,086 MB/s |

## A 10 MB payload at different chunk sizes (two relay hops)

| Chunk size | Chunks | Build manifest (hash, tree, sign) | Proof per chunk | Custody metadata per chunk | Receipt size | Overhead vs payload | Verify per chunk |
|---|---|---|---|---|---|---|---|
| 1 KiB | 10,240 | 87 ms | 14 hashes (448 B) | 520 B | 496 B | 147.66% | 27.6 us |
| 16 KiB | 640 | 28 ms | 10 hashes (320 B) | 392 B | 496 B | 8.45% | 46.1 us |
| 64 KiB | 160 | 35 ms | 8 hashes (256 B) | 328 B | 496 B | 2.01% | 105.4 us |
| 1,024 KiB | 10 | 18 ms | 4 hashes (128 B) | 200 B | 496 B | 0.11% | 1,223.2 us |

Overhead counts the chunk's leaf hash, Merkle proof, bundle id and index, plus one JSON custody receipt per relay hop, against the chunk's payload bytes. The manifest is sent once per payload (about 413 bytes). Receipts are JSON for readability; a binary encoding would be several times smaller.

## Reading this

- Chunk size drives overhead. At 64 KiB chunks custody adds about 2% to the data; at 1 MiB about 0.1%. At 1 KiB the per-hop receipts outweigh the data, so small bundles should use larger chunks or a binary receipt encoding.
- One core signs about 30,000 custody receipts per second and verifies about 10,000, so signing is unlikely to be the bottleneck on a ground segment.
- Building the fingerprint tree for a 10 MB payload takes tens of milliseconds.
- Flight processors are much slower than this desktop; on-board figures must be measured on the target hardware.
