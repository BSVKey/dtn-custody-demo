# HDTN results: custody payload through NASA HDTN

Run 2026-09-29 with `docker run --rm dtn-custody-hdtn` (NASA HDTN built from source, commit
7fbe90c). **Result: PASS.**

```
[hdtn] contact plan compiled -> module/router/contact_plans/custodyInterop.json (HDTN 7fbe90c)
[hdtn] prepared manifest + 20 chunk files (1272 bytes) in /tmp/send
[hdtn] sending at +18 s, inside the scheduled gap (15 s to 35 s)
[hdtn] received files: 21
HDTN_RESULT {"ok":true,"transport":"NASA HDTN hdtn-one-process (router ipn:10), BpSendFile ipn:1.1 -> BpReceiveFile ipn:2.1, TCPCLv4",
  "hdtnCommit":"7fbe90c","chunks":20,"expectedChunks":20,"accepted":20,"custodyHandoffsVerified":20,"complete":true,
  "payloadMatches":true,"schedule":{"gapDownS":15,"gapUpS":35,"sentAtS":18,"firstArrivalS":36,"lastArrivalS":36,"arrivedDuringGap":0},
  "heldAcrossGap":true,"gap":{"kind":"gap/1","link":"L2 (ipn:10 -> ipn:2)","downAt":15000,"upAt":35000,"durationMs":20000,
  "bundlesDelayed":[... 20 bundle ids ...],"bundlesLostConfirmed":[]}}
=== HDTN exit: 0 ===
```

What this shows:

- The contact plan was produced by `contact-plans/compile.mjs` from `hdtn/interop.json` and
  loaded by HDTN's router unchanged.
- The payload was sent 18 s after HDTN started, inside the scheduled gap on the router to
  receiver link. Nothing arrived during the gap; everything arrived at 36 s, one second
  after the contact opened. HDTN stored the bundles and forwarded them on schedule.
- At the receiver: the manifest verified against the pinned source key, all 20 chunks
  verified against the Merkle root, all 20 sender custody handoffs verified against the
  pinned sender key, and the payload reassembled exactly.

Boundary: HDTN's router has no hook for our agent, so the HDTN hop itself does not sign a
custody receipt; custody is signed at the sender and verified end to end at the receiver.
Timing uses a 20 s gap, not mission latency.
