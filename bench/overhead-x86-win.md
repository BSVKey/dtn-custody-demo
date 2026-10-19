### Run: x86-64 native, Windows 11, Node 24

2026-10-19T01:17:53.536Z, AMD Ryzen 5 7600 6-Core Processor, 12 threads, Node v24.14.1, win32 x64, single thread, largest batch measured 1,000,000 leaves.

**Primitives (node:crypto)**

| Operation | Per second | Each |
|---|---|---|
| Ed25519 COSE_Sign1 sign (receipt payload 96 B) | 28,891 | 34.6 us |
| Ed25519 COSE_Sign1 verify (includes SPKI key import) | 10,759 | 92.9 us |
| SHA-256 of a 1 KiB payload | 595,106 (609 MB/s) | 1.68 us |
| SHA-256 of a 64 KiB payload | 35,261 (2,311 MB/s) | 28.4 us |
| SHA-256 of a 1 MiB payload | 2,008 (2,105 MB/s) | 498 us |

**Per-bundle receipts in block 224 (stampBundleV2 / verifyBundleV2 on real bundle bytes)**

| Bundle payload | Bundle bytes | Block 224 + first receipt | Each further receipt | Stamp (decode, hash, sign, re-encode) | Verify one receipt | Decode only |
|---|---|---|---|---|---|---|
| 1 KiB | 1,077 | 168 B | 156 B | 76.0 us | 114 us | 5.27 us |
| 64 KiB | 65,591 | 168 B | 156 B | 742 us | 463 us | 280 us |
| 1 MiB | 1,048,631 | 168 B | 156 B | 9.48 ms | 4.28 ms | 3.67 ms |

**Batched receipts**

Batch receipt (COSE_Sign1, CBOR): 169 B. The same fields as custody-batch/1 canonical JSON: 470 B.
Leaf per bundle (Buffer path): content-bound 3.09 us plus the payload SHA-256 above; identity-bound 2.45 us. Reference hex path (agent/lib/merkle.mjs leafHash): 2.83 us.

| Bundles in batch | Reference: build tree at close + sign | Reference per leaf | Streaming: fold per leaf | Streaming: close (root + sign) | Inclusion proof | Proof check |
|---|---|---|---|---|---|---|
| 1,000 | 1.75 ms | 1.75 us | 1.31 us | 47.2 us | 320 B | 17.6 us |
| 10,000 | 18.9 ms | 1.89 us | 1.37 us | 49.7 us | 448 B | 26.5 us |
| 100,000 | 211 ms | 2.11 us | 1.26 us | 57.2 us | 544 B | 34.2 us |
| 1,000,000 | 2.22 s | 2.22 us | 1.43 us | 65.8 us | 640 B | 38.0 us |

**Receipt bytes per GB of payload (one custodian hop)**

| Bundle size | Bundles per GB | Per-bundle receipts | Batch, 1 s window, 100 Mbps | 1 Gbps | 10 Gbps | 100 Gbps | Batch, 60 s window, 100 Mbps | 100 Gbps |
|---|---|---|---|---|---|---|---|---|
| 1 KiB | 976,563 | 164,062,500 B (16.4%) | 13,520 B | 1,352 B | 135 B | 13.5 B | 225 B | 0.225 B |
| 64 KiB | 15,259 | 2,563,477 B (0.256%) | 13,520 B | 1,352 B | 135 B | 13.5 B | 225 B | 0.225 B |
| 1 MiB | 954 | 160,217 B (0.016%) | 13,520 B | 1,352 B | 135 B | 13.5 B | 225 B | 0.225 B |

**CPU to keep up with the link, percent of one core (over 100% means more than one core)**

| Link | Bundle size | Bundles/s | Per-bundle: stamp | Per-bundle: hash + sign only | Per-bundle: verifier | Batch, content-bound | Batch, identity-bound |
|---|---|---|---|---|---|---|---|
| 100 Mbps | 1 KiB | 12,207 | 92.7% | 44.3% | 139% | 7.57% | 4.73% |
| 100 Mbps | 64 KiB | 191 | 14.1% | 1.20% | 8.83% | 0.631% | 0.077% |
| 100 Mbps | 1 MiB | 12 | 11.3% | 0.635% | 5.10% | 0.603% | 8.1e-3% |
| 1 Gbps | 1 KiB | 122,070 | 927% | 443% | 1,392% | 75.7% | 47.3% |
| 1 Gbps | 64 KiB | 1,907 | 141% | 12.0% | 88.3% | 6.28% | 0.743% |
| 1 Gbps | 1 MiB | 119 | 113% | 6.35% | 51.0% | 5.99% | 0.050% |
| 10 Gbps | 1 KiB | 1,220,703 | 9,274% | 4,430% | 13,917% | 757% | 473% |
| 10 Gbps | 64 KiB | 19,073 | 1,415% | 120% | 883% | 62.7% | 7.40% |
| 10 Gbps | 1 MiB | 1,192 | 1,130% | 63.5% | 510% | 59.9% | 0.465% |
| 100 Gbps | 1 KiB | 12,207,031 | 92,739% | 44,303% | 139,175% | 7,571% | 4,731% |
| 100 Gbps | 64 KiB | 190,735 | 14,145% | 1,201% | 8,829% | 627% | 73.9% |
| 100 Gbps | 1 MiB | 11,921 | 11,298% | 635% | 5,103% | 599% | 4.62% |

**Latency**

| Link | Bundle size | Per-bundle: added on the forwarding path, per bundle per hop | Batch: on the forwarding path | Batch close, streaming, 60 s window | Batch close, reference rebuild, 1 s window | Batch close, reference rebuild, 60 s window |
|---|---|---|---|---|---|---|
| 100 Mbps | 1 KiB | 89.4 us | 0 | 65.8 us | 25.8 ms (12,207 leaves) | 1.63 s (732,422 leaves) |
| 100 Mbps | 64 KiB | 755 us | 0 | 57.2 us | 333 us (191 leaves) | 24.2 ms (11,444 leaves) |
| 100 Mbps | 1 MiB | 9.49 ms | 0 | 47.2 us | 20.8 us (12 leaves) | 1.25 ms (715 leaves) |
| 1 Gbps | 1 KiB | 77.3 us | 0 | 65.8 us | 271 ms (122,070 leaves) | 16.3 s (7,324,219 leaves, extrapolated) |
| 1 Gbps | 64 KiB | 743 us | 0 | 65.8 us | 3.61 ms (1,907 leaves) | 254 ms (114,441 leaves) |
| 1 Gbps | 1 MiB | 9.48 ms | 0 | 49.7 us | 208 us (119 leaves) | 13.5 ms (7,153 leaves) |
| 10 Gbps | 1 KiB | 76.1 us | 0 | 65.8 us | 2.71 s (1,220,703 leaves, extrapolated) | 163 s (73,242,188 leaves, extrapolated) |
| 10 Gbps | 64 KiB | 742 us | 0 | 65.8 us | 40.3 ms (19,073 leaves) | 2.54 s (1,144,409 leaves, extrapolated) |
| 10 Gbps | 1 MiB | 9.48 ms | 0 | 57.2 us | 2.26 ms (1,192 leaves) | 151 ms (71,526 leaves) |
| 100 Gbps | 1 KiB | 76.0 us | 0 | 65.8 us | 27.1 s (12,207,031 leaves, extrapolated) | 1,626 s (732,421,875 leaves, extrapolated) |
| 100 Gbps | 64 KiB | 742 us | 0 | 65.8 us | 424 ms (190,735 leaves) | 25.4 s (11,444,092 leaves, extrapolated) |
| 100 Gbps | 1 MiB | 9.48 ms | 0 | 65.8 us | 25.2 ms (11,921 leaves) | 1.59 s (715,256 leaves) |
