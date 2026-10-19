[overhead] x86_64, 12 CPUs visible, gcc (Debian 12.2.0-14+deb12u1) 12.2.0, libsodium 1.0.18-1+deb12u1, node v20.20.2
[overhead] CPU: AMD Ryzen 5 7600 6-Core Processor
C_RESULT {"impl":"tweetnacl","messageBytes":128,"signPerSec":862.6,"verifyPerSec":493.1,"sha256":[{"bytes":1024,"perSec":320746.3,"MBps":328.4},{"bytes":65536,"perSec":5881.3,"MBps":385.4},{"bytes":1048576,"perSec":379.1,"MBps":397.5}],"batchLeafPlusNodePerSec":856243.2}
C_RESULT {"impl":"libsodium","messageBytes":128,"signPerSec":77008.5,"verifyPerSec":27498.3,"sha256":[{"bytes":1024,"perSec":329104.3,"MBps":337.0},{"bytes":65536,"perSec":6179.7,"MBps":405.0},{"bytes":1048576,"perSec":319.6,"MBps":335.1}],"batchLeafPlusNodePerSec":865289.5}
### Run: x86-64, Linux container (Docker Desktop, WSL2), Node 20

2026-10-19T01:18:30.040Z, AMD Ryzen 5 7600 6-Core Processor, 12 threads, Node v20.20.2, linux x64, single thread, largest batch measured 1,000,000 leaves.

**Primitives (node:crypto)**

| Operation | Per second | Each |
|---|---|---|
| Ed25519 COSE_Sign1 sign (receipt payload 96 B) | 33,561 | 29.8 us |
| Ed25519 COSE_Sign1 verify (includes SPKI key import) | 6,269 | 160 us |
| SHA-256 of a 1 KiB payload | 723,163 (741 MB/s) | 1.38 us |
| SHA-256 of a 64 KiB payload | 29,814 (1,954 MB/s) | 33.5 us |
| SHA-256 of a 1 MiB payload | 1,955 (2,050 MB/s) | 511 us |

**Per-bundle receipts in block 224 (stampBundleV2 / verifyBundleV2 on real bundle bytes)**

| Bundle payload | Bundle bytes | Block 224 + first receipt | Each further receipt | Stamp (decode, hash, sign, re-encode) | Verify one receipt | Decode only |
|---|---|---|---|---|---|---|
| 1 KiB | 1,077 | 168 B | 156 B | 82.4 us | 192 us | 6.04 us |
| 64 KiB | 65,591 | 168 B | 156 B | 798 us | 493 us | 299 us |
| 1 MiB | 1,048,631 | 168 B | 156 B | 10.3 ms | 4.53 ms | 3.71 ms |

**Batched receipts**

Batch receipt (COSE_Sign1, CBOR): 169 B. The same fields as custody-batch/1 canonical JSON: 470 B.
Leaf per bundle (Buffer path): content-bound 2.88 us plus the payload SHA-256 above; identity-bound 2.50 us. Reference hex path (agent/lib/merkle.mjs leafHash): 2.97 us.

| Bundles in batch | Reference: build tree at close + sign | Reference per leaf | Streaming: fold per leaf | Streaming: close (root + sign) | Inclusion proof | Proof check |
|---|---|---|---|---|---|---|
| 1,000 | 2.98 ms | 2.98 us | 1.30 us | 42.4 us | 320 B | 20.4 us |
| 10,000 | 20.8 ms | 2.08 us | 1.73 us | 53.8 us | 448 B | 26.5 us |
| 100,000 | 209 ms | 2.09 us | 1.30 us | 53.1 us | 544 B | 29.9 us |
| 1,000,000 | 1.98 s | 1.98 us | 1.48 us | 51.4 us | 640 B | 36.1 us |

**Receipt bytes per GB of payload (one custodian hop)**

| Bundle size | Bundles per GB | Per-bundle receipts | Batch, 1 s window, 100 Mbps | 1 Gbps | 10 Gbps | 100 Gbps | Batch, 60 s window, 100 Mbps | 100 Gbps |
|---|---|---|---|---|---|---|---|---|
| 1 KiB | 976,563 | 164,062,500 B (16.4%) | 13,520 B | 1,352 B | 135 B | 13.5 B | 225 B | 0.225 B |
| 64 KiB | 15,259 | 2,563,477 B (0.256%) | 13,520 B | 1,352 B | 135 B | 13.5 B | 225 B | 0.225 B |
| 1 MiB | 954 | 160,217 B (0.016%) | 13,520 B | 1,352 B | 135 B | 13.5 B | 225 B | 0.225 B |

**CPU to keep up with the link, percent of one core (over 100% means more than one core)**

| Link | Bundle size | Bundles/s | Per-bundle: stamp | Per-bundle: hash + sign only | Per-bundle: verifier | Batch, content-bound | Batch, identity-bound |
|---|---|---|---|---|---|---|---|
| 100 Mbps | 1 KiB | 12,207 | 101% | 38.1% | 235% | 7.02% | 4.86% |
| 100 Mbps | 64 KiB | 191 | 15.2% | 1.21% | 9.40% | 0.726% | 0.079% |
| 100 Mbps | 1 MiB | 12 | 12.2% | 0.645% | 5.40% | 0.618% | 7.7e-3% |
| 1 Gbps | 1 KiB | 122,070 | 1,006% | 381% | 2,348% | 70.1% | 48.6% |
| 1 Gbps | 64 KiB | 1,907 | 152% | 12.1% | 94.0% | 7.23% | 0.762% |
| 1 Gbps | 1 MiB | 119 | 122% | 6.45% | 54.0% | 6.15% | 0.050% |
| 10 Gbps | 1 KiB | 1,220,703 | 10,060% | 3,806% | 23,477% | 701% | 486% |
| 10 Gbps | 64 KiB | 19,073 | 1,523% | 121% | 940% | 72.3% | 7.59% |
| 10 Gbps | 1 MiB | 1,192 | 1,222% | 64.5% | 540% | 61.5% | 0.477% |
| 100 Gbps | 1 KiB | 12,207,031 | 100,596% | 38,061% | 234,767% | 7,014% | 4,857% |
| 100 Gbps | 64 KiB | 190,735 | 15,230% | 1,208% | 9,404% | 723% | 75.9% |
| 100 Gbps | 1 MiB | 11,921 | 12,223% | 645% | 5,399% | 615% | 4.75% |

**Latency**

| Link | Bundle size | Per-bundle: added on the forwarding path, per bundle per hop | Batch: on the forwarding path | Batch close, streaming, 60 s window | Batch close, reference rebuild, 1 s window | Batch close, reference rebuild, 60 s window |
|---|---|---|---|---|---|---|
| 100 Mbps | 1 KiB | 95.8 us | 0 | 51.4 us | 25.5 ms (12,207 leaves) | 1.45 s (732,422 leaves) |
| 100 Mbps | 64 KiB | 812 us | 0 | 53.1 us | 569 us (191 leaves) | 23.9 ms (11,444 leaves) |
| 100 Mbps | 1 MiB | 10.3 ms | 0 | 42.4 us | 35.6 us (12 leaves) | 2.13 ms (715 leaves) |
| 1 Gbps | 1 KiB | 83.8 us | 0 | 51.4 us | 242 ms (122,070 leaves) | 14.5 s (7,324,219 leaves, extrapolated) |
| 1 Gbps | 64 KiB | 800 us | 0 | 51.4 us | 3.97 ms (1,907 leaves) | 226 ms (114,441 leaves) |
| 1 Gbps | 1 MiB | 10.3 ms | 0 | 53.8 us | 356 us (119 leaves) | 14.9 ms (7,153 leaves) |
| 10 Gbps | 1 KiB | 82.5 us | 0 | 51.4 us | 2.42 s (1,220,703 leaves, extrapolated) | 145 s (73,242,188 leaves, extrapolated) |
| 10 Gbps | 64 KiB | 799 us | 0 | 51.4 us | 39.8 ms (19,073 leaves) | 2.26 s (1,144,409 leaves, extrapolated) |
| 10 Gbps | 1 MiB | 10.3 ms | 0 | 53.1 us | 2.48 ms (1,192 leaves) | 149 ms (71,526 leaves) |
| 100 Gbps | 1 KiB | 82.4 us | 0 | 51.4 us | 24.2 s (12,207,031 leaves, extrapolated) | 1,449 s (732,421,875 leaves, extrapolated) |
| 100 Gbps | 64 KiB | 799 us | 0 | 51.4 us | 377 ms (190,735 leaves) | 22.6 s (11,444,092 leaves, extrapolated) |
| 100 Gbps | 1 MiB | 10.3 ms | 0 | 51.4 us | 24.9 ms (11,921 leaves) | 1.42 s (715,256 leaves) |
