# Aalyria Hardy interop: PASS

Run 2026-09-29 (twice, same result). Reproduce: `make hardy`.
Hardy revision `0da2247` (hardy-bpa-server, hardy-tvr and the `bundle` tool 0.2.0), taken
from Hardy's published container images pinned by digest.

Our custody agent attaches to Hardy only through Hardy's public interfaces:

```
our sender app --gRPC Application API--> Hardy BPA ipn:20 --gRPC CLA API--> our custody bridge (peer ipn:30)
                                            ^
                                  hardy-tvr contact windows, compiled by contact-plans/compile.mjs
```

- The sender registers as a Hardy application (`ipn:20.1`) and hands Hardy the manifest
  and 20 chunk bundles for `ipn:2.1`.
- The downstream peer is a convergence layer we register through Hardy's CLA API.
- The route to `ipn:2.*` exists only in the contact windows Hardy's time-variant routing
  agent installs from the compiled plan (`node contact-plans/compile.mjs <plan> --hardy
  <file> --epoch <time zero>`): open 0 to 15 s, closed 15 to 35 s, open from 35 s.
- Every bundle Hardy forwards is saved as raw BPv7 and its payload extracted with
  Hardy's own `bundle extract` before verification.

```
[hardy] custody bridge registered as a Hardy CLA (node ipn:20.0); peer ipn:30.0 announced
[hardy] sending at +18 s, inside the scheduled gap (15 s to 35 s)
[hardy] application ipn:20.1 handed Hardy manifest + 20 bundles for ipn:2.1
[hardy] bundles forwarded by Hardy to the custody bridge: 21
HARDY_RESULT {"ok":true, "bundlesForwarded":21, "chunks":20, "accepted":20, "custodyHandoffsVerified":20,
  "complete":true, "payloadMatches":true,
  "schedule":{"gapDownS":15,"gapUpS":35,"sentAtS":18.1,"firstForwardS":35,"lastForwardS":35,"arrivedDuringGap":0},
  "heldAcrossGap":true, "gap":{"kind":"gap/1","downAt":15000,"upAt":35000,"durationMs":20000, ...}}
=== HARDY exit: 0 ===
```

| Check | Result |
|---|---|
| Chunks verified against the Merkle root | 20 / 20 |
| Custody handoffs verified against the pinned sender key | 20 / 20 |
| Payload reassembled byte for byte | yes |
| Bundles forwarded while the route was closed | 0 |
| First forward after the contact opened (35 s) | 35 s |

Scope, stated plainly: this run exercises Hardy's BPA, storage, time-variant routing and
its application and CLA APIs. The link out of Hardy is our gRPC convergence layer rather
than TCPCLv4, because the published server has no statically configured outbound peers;
Hardy's own test suite covers its TCPCLv4 interoperability with HDTN, ION, uD3TN and
others. The protocol files in `hardy/proto/` are Hardy's, unmodified (Apache-2.0).
