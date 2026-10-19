[overhead] aarch64, 12 CPUs visible, gcc (Debian 12.2.0-14+deb12u1) 12.2.0, libsodium 1.0.18-1+deb12u1, node v20.20.2
[overhead] CPU: AMD Ryzen 5 7600 6-Core Processor
C_RESULT {"impl":"tweetnacl","messageBytes":128,"signPerSec":224.0,"verifyPerSec":117.7,"sha256":[{"bytes":1024,"perSec":39320.4,"MBps":40.3},{"bytes":65536,"perSec":782.2,"MBps":51.3},{"bytes":1048576,"perSec":46.8,"MBps":49.1}],"batchLeafPlusNodePerSec":69856.5}
C_RESULT {"impl":"libsodium","messageBytes":128,"signPerSec":10934.6,"verifyPerSec":5108.8,"sha256":[{"bytes":1024,"perSec":36532.9,"MBps":37.4},{"bytes":65536,"perSec":738.9,"MBps":48.4},{"bytes":1048576,"perSec":46.9,"MBps":49.2}],"batchLeafPlusNodePerSec":67406.3}
### Run: aarch64 under QEMU user-mode emulation on the same x86 desktop (emulated, not flight hardware)

2026-10-19T01:19:34.136Z, unknown, 12 threads, Node v20.20.2, linux arm64, single thread, largest batch measured 100,000 leaves.

**Primitives (node:crypto)**

| Operation | Per second | Each |
|---|---|---|
| Ed25519 COSE_Sign1 sign (receipt payload 96 B) | 1,742 | 574 us |
| Ed25519 COSE_Sign1 verify (includes SPKI key import) | 341 | 2.93 ms |
| SHA-256 of a 1 KiB payload | 29,984 (31 MB/s) | 33.4 us |
| SHA-256 of a 64 KiB payload | 2,009 (132 MB/s) | 498 us |
| SHA-256 of a 1 MiB payload | 135 (141 MB/s) | 7.41 ms |

**Per-bundle receipts in block 224 (stampBundleV2 / verifyBundleV2 on real bundle bytes)**

| Bundle payload | Bundle bytes | Block 224 + first receipt | Each further receipt | Stamp (decode, hash, sign, re-encode) | Verify one receipt | Decode only |
|---|---|---|---|---|---|---|
| 1 KiB | 1,077 | 168 B | 156 B | 1.33 ms | 1.91 ms | 83.8 us |
| 64 KiB | 65,591 | 168 B | 156 B | 10.3 ms | 4.43 ms | 2.23 ms |
| 1 MiB | 1,048,631 | 168 B | 156 B | 76.9 ms | 46.2 ms | 33.1 ms |

**Batched receipts**

Batch receipt (COSE_Sign1, CBOR): 169 B. The same fields as custody-batch/1 canonical JSON: 470 B.
Leaf per bundle (Buffer path): content-bound 61.5 us plus the payload SHA-256 above; identity-bound 50.8 us. Reference hex path (agent/lib/merkle.mjs leafHash): 79.1 us.

| Bundles in batch | Reference: build tree at close + sign | Reference per leaf | Streaming: fold per leaf | Streaming: close (root + sign) | Inclusion proof | Proof check |
|---|---|---|---|---|---|---|
| 1,000 | 43.3 ms | 43.3 us | 42.1 us | 655 us | 320 B | 420 us |
| 10,000 | 416 ms | 41.6 us | 23.0 us | 762 us | 448 B | 744 us |
| 100,000 | 4.27 s | 42.7 us | 26.4 us | 865 us | 544 B | 641 us |

**Receipt bytes per GB of payload (one custodian hop)**

| Bundle size | Bundles per GB | Per-bundle receipts | Batch, 1 s window, 100 Mbps | 1 Gbps | 10 Gbps | 100 Gbps | Batch, 60 s window, 100 Mbps | 100 Gbps |
|---|---|---|---|---|---|---|---|---|
| 1 KiB | 976,563 | 164,062,500 B (16.4%) | 13,520 B | 1,352 B | 135 B | 13.5 B | 225 B | 0.225 B |
| 64 KiB | 15,259 | 2,563,477 B (0.256%) | 13,520 B | 1,352 B | 135 B | 13.5 B | 225 B | 0.225 B |
| 1 MiB | 954 | 160,217 B (0.016%) | 13,520 B | 1,352 B | 135 B | 13.5 B | 225 B | 0.225 B |

**CPU to keep up with the link, percent of one core (over 100% means more than one core)**

| Link | Bundle size | Bundles/s | Per-bundle: stamp | Per-bundle: hash + sign only | Per-bundle: verifier | Batch, content-bound | Batch, identity-bound |
|---|---|---|---|---|---|---|---|
| 100 Mbps | 1 KiB | 12,207 | 1,624% | 742% | 2,328% | 148% | 94.3% |
| 100 Mbps | 64 KiB | 191 | 197% | 20.4% | 84.5% | 11.2% | 1.53% |
| 100 Mbps | 1 MiB | 12 | 91.7% | 9.52% | 55.1% | 9.00% | 0.149% |
| 1 Gbps | 1 KiB | 122,070 | 16,238% | 7,415% | 23,276% | 1,481% | 943% |
| 1 Gbps | 64 KiB | 1,907 | 1,966% | 204% | 845% | 112% | 14.8% |
| 1 Gbps | 1 MiB | 119 | 917% | 95.2% | 551% | 89.5% | 0.978% |
| 10 Gbps | 1 KiB | 1,220,703 | 162,379% | 74,154% | 232,757% | 14,805% | 9,426% |
| 10 Gbps | 64 KiB | 19,073 | 19,663% | 2,044% | 8,452% | 1,117% | 147% |
| 10 Gbps | 1 MiB | 1,192 | 9,172% | 952% | 5,511% | 894% | 9.26% |
| 100 Gbps | 1 KiB | 12,207,031 | 1,623,795% | 741,539% | 2,327,575% | 148,051% | 94,264% |
| 100 Gbps | 64 KiB | 190,735 | 196,628% | 20,442% | 84,517% | 11,169% | 1,473% |
| 100 Gbps | 1 MiB | 11,921 | 91,721% | 9,522% | 55,109% | 8,942% | 92.1% |

**Latency**

| Link | Bundle size | Per-bundle: added on the forwarding path, per bundle per hop | Batch: on the forwarding path | Batch close, streaming, 60 s window | Batch close, reference rebuild, 1 s window | Batch close, reference rebuild, 60 s window |
|---|---|---|---|---|---|---|
| 100 Mbps | 1 KiB | 1.34 ms | 0 | 865 us | 521 ms (12,207 leaves) | 31.2 s (732,422 leaves, extrapolated) |
| 100 Mbps | 64 KiB | 10.3 ms | 0 | 865 us | 8.26 ms (191 leaves) | 488 ms (11,444 leaves) |
| 100 Mbps | 1 MiB | 77.0 ms | 0 | 655 us | 516 us (12 leaves) | 31.0 ms (715 leaves) |
| 1 Gbps | 1 KiB | 1.33 ms | 0 | 865 us | 5.21 s (122,070 leaves, extrapolated) | 312 s (7,324,219 leaves, extrapolated) |
| 1 Gbps | 64 KiB | 10.3 ms | 0 | 865 us | 79.3 ms (1,907 leaves) | 4.88 s (114,441 leaves, extrapolated) |
| 1 Gbps | 1 MiB | 76.9 ms | 0 | 762 us | 5.16 ms (119 leaves) | 298 ms (7,153 leaves) |
| 10 Gbps | 1 KiB | 1.33 ms | 0 | 865 us | 52.1 s (1,220,703 leaves, extrapolated) | 3,124 s (73,242,188 leaves, extrapolated) |
| 10 Gbps | 64 KiB | 10.3 ms | 0 | 865 us | 814 ms (19,073 leaves) | 48.8 s (1,144,409 leaves, extrapolated) |
| 10 Gbps | 1 MiB | 76.9 ms | 0 | 865 us | 49.6 ms (1,192 leaves) | 3.05 s (71,526 leaves) |
| 100 Gbps | 1 KiB | 1.33 ms | 0 | 865 us | 521 s (12,207,031 leaves, extrapolated) | 31,244 s (732,421,875 leaves, extrapolated) |
| 100 Gbps | 64 KiB | 10.3 ms | 0 | 865 us | 8.14 s (190,735 leaves, extrapolated) | 488 s (11,444,092 leaves, extrapolated) |
| 100 Gbps | 1 MiB | 76.9 ms | 0 | 865 us | 509 ms (11,921 leaves) | 30.5 s (715,256 leaves, extrapolated) |
