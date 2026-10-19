### Custodian latency: x86-64 native, Windows 11, Node 24

2026-10-19T01:37:04.248Z, AMD Ryzen 5 7600 6-Core Processor, Node v24.14.1, single thread, medians. Ed25519 COSE_Sign1 sign alone: 28.6 us.

| Bundle | Before: stampBundleV2 | Splice (no incremental work) | Incremental, 1,472 B segments: added after last byte | CPU per bundle, incl. while arriving | Incremental, 64 KiB segments: added after last byte | CPU per bundle |
|---|---|---|---|---|---|---|
| 1 KiB | 52.7 us | 40.9 us | 39.6 us (1.3x less) | 40.1 us | 38.9 us (1.4x less) | 39.4 us |
| 64 KiB | 699.6 us | 332.4 us | 56.1 us (12.5x less) | 326.8 us | 53.5 us (13.1x less) | 337.8 us |
| 1 MiB | 10.06 ms | 4.99 ms | 126.2 us (79.7x less) | 4.72 ms | 162.9 us (61.8x less) | 4.85 ms |

Signing while the convergence layer starts sending: only the 39 B before block 224 (here the primary block) can leave before the signature exists, 31.2 ns at 10 Gbps and 3.1 ns at 100 Gbps, against a 28.6 us signature.
