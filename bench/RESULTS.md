# Custody layer: performance and overhead

Measured 2026-09-29 on AMD Ryzen 5 7600 6-Core Processor, 12 threads, Node v24.14.1, win32 x64, single thread.
Reproduce: `node bench/bench.mjs`. Figures are for this machine; flight processors will be slower.

## Signing and verification

| Operation | Per second | Microseconds each |
|---|---|---|
| Ed25519 sign (one per custody receipt) | 34,956 | 28.6 |
| Ed25519 verify | 11,422 | 87.6 |
| Create a full custody receipt (canonical JSON, SHA-256, sign) | 29,922 | 33.4 |
| Verify a full custody receipt | 10,934 | 91.5 |

## Chunk fingerprinting (SHA-256 leaf hash)

| Chunk size | Hashes per second | Throughput |
|---|---|---|
| 1 KiB | 358,884 | 367 MB/s |
| 64 KiB | 11,677 | 765 MB/s |
| 1,024 KiB | 1,027 | 1,077 MB/s |

## A 10 MB payload at different chunk sizes (two relay hops)

| Chunk size | Chunks | Build manifest (hash, tree, sign) | Proof per chunk | Custody metadata per chunk | Receipt size | Overhead vs payload | Verify per chunk |
|---|---|---|---|---|---|---|---|
| 1 KiB | 10,240 | 89 ms | 14 hashes (448 B) | 520 B | 496 B | 147.66% | 26.8 us |
| 16 KiB | 640 | 23 ms | 10 hashes (320 B) | 392 B | 496 B | 8.45% | 47.7 us |
| 64 KiB | 160 | 27 ms | 8 hashes (256 B) | 328 B | 496 B | 2.01% | 108.7 us |
| 1,024 KiB | 10 | 18 ms | 4 hashes (128 B) | 200 B | 496 B | 0.11% | 1,202.1 us |

Overhead counts the chunk's leaf hash, Merkle proof, bundle id and index, plus one JSON custody receipt per relay hop, against the chunk's payload bytes. The manifest is sent once per payload (about 413 bytes). Receipts are JSON for readability; a binary encoding would be several times smaller.

## Reading this

- Chunks of 16 KiB or more keep custody overhead near or below 1% of the data.
- One relay can sign thousands of receipts per second on one core, well above typical lunar relay bundle rates.
- Verification is cheap enough to check every chunk and every hop at the destination.
