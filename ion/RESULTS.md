# JPL ION interop: PASS

Run 2026-09-29, ION built from source (github.com/nasa-jpl/ION-DTN, commit `c5a4d87`),
Docker `node:20-bookworm-slim`, `--privileged`. Reproduce: `make ion`.

Two ION nodes run in one container, each in its own IPC namespace (ION keeps its state in
SysV shared memory): node 1 (sender, `bpsendfile`) and node 2 (receiver, `bprecvfile`),
over the UDP convergence layer. Routing is ION's contact graph routing over a contact
plan compiled by `contact-plans/compile.mjs` from `ion/interop.json`:

```
a contact +0 +15 1 2 12500000
a range +0 +15 1 2 1
a contact +35 +600 1 2 12500000
a range +35 +600 1 2 1
```

The node 1 to node 2 contact is scheduled down from 15 s to 35 s. The custody payload
(manifest plus 20 chunk files, each with a signed custody handoff) was handed to ION
inside that gap, so ION had to hold every bundle and forward it when the contact opened.

```
[ion] prepared manifest + 20 chunk files (1248 bytes) in /tmp/send
[ion] sending at +26 s, inside the scheduled gap (15 s to 35 s)
[ion] node 1 queued 21 files; holding for the contact at +35 s
[ion] received files: 21
ION_RESULT {"ok":true, "files":21, "chunks":20, "accepted":20, "custodyHandoffsVerified":20,
  "complete":true, "payloadMatches":true,
  "schedule":{"gapDownS":15,"gapUpS":35,"sentAtS":26.1,"firstArrivalS":36.4,"lastArrivalS":36.4,"arrivedDuringGap":0},
  "heldAcrossGap":true, "gap":{"kind":"gap/1","downAt":15000,"upAt":35000,"durationMs":20000, "bundlesDelayed":[20 ids], ...}}
=== ION exit: 0 ===
```

| Check | Result |
|---|---|
| Manifest verified against the pinned source key | yes |
| Chunks verified against the Merkle root | 20 / 20 |
| Custody handoffs verified against the pinned sender key | 20 / 20 |
| Payload reassembled byte for byte | yes |
| Bundles arriving while the contact was down | 0 |
| First arrival after the contact opened (35 s) | 36.4 s |
| Gap record produced | yes, 20 bundles delayed |

Notes: the send time is 26 s rather than the 18 s the script waits (a second run gave the same 26 s and 36.4 s), because ION's own
start-up (`ionstart`) took about 8 s and the wait begins after it; that is still inside
the 15 to 35 s gap. Times are measured from just before node 1 starts, while ION counts its
relative contact times from when it loads them, a second or two later, so the timing
checks allow 1 to 2 s of slack. Together with `hdtn/RESULTS.md` (NASA HDTN) and
`r2/RESULTS.md` (uD3TN), the same custody records now pass over three independent DTN
implementations.
