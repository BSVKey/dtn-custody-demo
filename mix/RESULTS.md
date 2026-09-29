# Mixed-implementation chain (uD3TN -> NASA HDTN -> uD3TN): PASS

Run 2026-09-29 (twice, same result). Reproduce: `make mix`.
Builds: NASA HDTN `7fbe90c` and uD3TN `00b2fbe`, both from source, in one
`node:20-bookworm-slim` image. No privileges needed.

```
uD3TN node ipn:1 --TCPCLv3--> NASA HDTN router ipn:10 --TCPCLv3--> uD3TN node ipn:2
 (our sender agent, AAP)       (contact plan from compile.mjs)      (our receiver agent, AAP)
```

TCPCLv3 is the convergence layer both implementations speak. HDTN routes by a contact
plan compiled from `mix/interop.json` by `contact-plans/compile.mjs`; its link to the
uD3TN receiver is scheduled down from 15 s to 35 s. The sender hands uD3TN the manifest
and 19 chunk bundles at 18 s, inside that gap, so every bundle crosses from one
implementation into the other, waits in HDTN's storage, and crosses back.

```
[mix] sending at +18 s, inside the scheduled HDTN -> uD3TN gap (15 s to 35 s)
[mix] uD3TN ipn:1 accepted manifest + 19 bundles for ipn:2.1
MIX_RESULT {"ok":true, "transport":"uD3TN ipn:1 -> NASA HDTN ipn:10 -> uD3TN ipn:2, TCPCLv3 both links, BPv7",
  "received":20, "chunks":19, "accepted":19, "custodyHandoffsVerified":19, "complete":true, "payloadMatches":true,
  "schedule":{"gapDownS":15,"gapUpS":35,"sentAtS":18.1,"firstArrivalS":36,"lastArrivalS":36.1,"arrivedDuringGap":0},
  "heldAcrossGap":true, "gap":{"kind":"gap/1","downAt":15000,"upAt":35000,"durationMs":20000, "bundlesDelayed":[19 ids]}}
=== MIX exit: 0 ===
```

| Check | Result |
|---|---|
| Bundles uD3TN handed to HDTN (HDTN TCPCLv3 induct count) | 20 / 20 |
| Chunks verified at the uD3TN receiver against the Merkle root | 19 / 19 |
| Custody handoffs verified against the pinned sender key | 19 / 19 |
| Payload reassembled byte for byte | yes |
| Bundles arriving while HDTN's link was scheduled down | 0 |
| First arrival after the contact opened (35 s) | 36 s |

## One interoperability finding

The first run delivered only 10 of 20 bundles after the gap. The cause: uD3TN's
TCPCLv3 does not send per-bundle ACK segments, and HDTN's TCPCLv3 outduct counts
unacknowledged bundles against `maxNumberOfBundlesInPipeline` (20 in HDTN's stock config),
so a stored backlog stalls part-way. The run script raises that window to 1000 in a copy
of HDTN's stock config; nothing else is changed. Operators mixing these two
implementations should set the window above their largest expected backlog, or use a
convergence layer where both sides acknowledge. The custody layer is what caught the
shortfall: the receiver reported the payload incomplete (9 of 19 chunks verified) instead of
accepting a partial one.
