# dtn-custody-demo

**Private. Proprietary. Pre-funding feasibility work.** Not for distribution.

A feasibility demonstration of a **verifiable data-custody and relay-payment layer**
over delay/disruption-tolerant networking (DTN). It shows a chunked payload crossing a
multi-hop, occultation-interrupted link where every chunk is verified against a Merkle
root, each relay hop leaves a signed custody receipt, the blackout produces a
documented gap object, and delivery is bound to a real BSV settlement.

This rides standard **BPv7 (RFC 9171)** for transport and adds the custody +
verification + payment work as an application-layer agent on top. It reuses the
shipped BSVKey receipt / `bindX402Receipt` code. **Out of scope:** the physical RF
layer (modulation, coding, pointing, FEC).

Full design, milestones, acceptance criteria, and fundability mapping:
[`docs/BUILD-PLAN.md`](docs/BUILD-PLAN.md).

## One-line scope
`chunk → Merkle → BPv7 bundles → multi-hop store-and-forward with a scripted
occultation → out-of-order Merkle verification → per-hop custody receipts → gap object
across the blackout → delivery bound to a real BSV settlement → provenance anchor.`

## Layout
```
agent/               the application agent
  lib/               canonical hashing, Merkle tree, keys, receipts, gap object
  source.mjs         chunk + Merkle + signed manifest
  relay.mjs          per-hop custody receipts
  dest.mjs           out-of-order verify, reassemble, chain check, settlement binding
transport/
  sim.mjs            in-process DTN simulator (delay, reorder, occultation)
  bpv7-adapter.md    the real BPv7/uD3TN + netem seam (same shape as sim.mjs)
test/                the acceptance-criteria suite (node --test)
contact-plans/       per-tier link schedules with occultation windows
docs/                BUILD-PLAN.md (the full plan)
docker-compose.yml   the 4-node BPv7 + netem testbed (stub)
Makefile             one-command entry points
run-demo.mjs         the end-to-end demo (npm run demo)
```

## Status
The **application layer is implemented and green**: `npm test` passes the acceptance
criteria and `npm run demo` runs the full pipeline offline (chunk → Merkle →
occultation → out-of-order verify → custody chain → gap object → settlement binding),
zero dependencies. **Two seams remain**, both requiring external infra or a broadcast:
1. **Real transport (M0):** swap `transport/sim.mjs` for BPv7 over µD3TN/dtn7-rs with
   `netem` shaping in the docker testbed. Interface documented in
   `transport/bpv7-adapter.md`; the agent code is unchanged behind it.
2. **Live settlement:** the delivery binding uses a placeholder `settlementRef`; the
   live path takes a real BSV txid (`readSettlement(res).txid`) and anchors the root
   on-chain.

Run it:
```bash
npm test        # acceptance criteria, offline, deterministic
npm run demo    # the end-to-end pipeline with readable output
```

## Acceptance criteria (what "done" means)
1. Out-of-order chunk integrity against a Merkle root; a tampered chunk is rejected.
2. A 3-hop custody chain verifies; a forged or missing hop is detected.
3. A gap object documents the occultation and reconciles on link reopen.
4. Delivery is bound to a settlement (matching txid passes, unbound refuses).
5. The manifest root is anchored on-chain and re-derives from the received payload.
6. Runs headless in CI (compressed delays) plus a `--live` mode with one real anchor.

---
© Embryo Space Inc. (DBA BSVKey). All rights reserved. Proprietary and confidential.
