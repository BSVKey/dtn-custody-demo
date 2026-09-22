# dtn-custody-demo

[![License: Apache 2.0](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](LICENSE)

A **reference implementation of a verifiable data-custody and relay-payment layer** for
delay/disruption-tolerant networking (DTN), with settlement on **BSV**. A chunked
payload crosses a multi-hop, occultation-interrupted link where every chunk is verified
against a Merkle root, each relay hop leaves a signed custody receipt, the blackout
produces a documented gap object, and delivery is bound to a real on-chain BSV
settlement, with the manifest root anchored on chain for provenance.

It rides standard **BPv7 (RFC 9171)** for transport (µD3TN) and adds the custody,
verification, and payment work as an application-layer agent on top, using the same
content-addressed receipt route as [`@bsvkey/x402-bsv-client`](https://www.npmjs.com/package/@bsvkey/x402-bsv-client)
and the [ASM capacity-attest](https://github.com/YE-YI7/asm-spec) work. **Out of scope,
by design:** the physical RF layer (modulation, coding, pointing, FEC).

This is published as an open reference implementation for the BSV ecosystem: the
protocol, agent library, DTN adapters, and on-chain verifiers are here under Apache-2.0
so anyone can build verifiable data-custody and relay settlement on BSV. See
[Open core vs. hosted service](#open-core-vs-hosted-service).

Full design, milestones, and acceptance criteria: [`docs/BUILD-PLAN.md`](docs/BUILD-PLAN.md).

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
The **application layer is implemented and green**, and it has been proven over real
infrastructure:
- `npm test` passes the acceptance criteria; `npm run demo` runs the full pipeline
  offline (zero dependencies).
- **M0 (`make spike` / `make spike-local`)** carries the payload over a real transport
  through an occultation: `spike-local` over real sockets, `make spike` over real veths
  with `tc netem` and a real 100%-loss L2 blackout. See `m0/RESULTS.md`.
- **R2 (`make r2`)** carries the same custody chain over **real µD3TN BPv7**, with the
  bundles **held in µD3TN storage across a scheduled contact gap** (real bundle
  custody, not TCP retransmit). See `r2/RESULTS.md`.

- **Live settlement (`make live`)** binds the delivery receipt to a **real, on-chain-
  verified BSV settlement** (WhatsOnChain): the receipt names the txid the verifier
  paid, and that txid is confirmed on chain to pay the seller. Verified against a real
  mainnet settlement (5942 sats, 2351+ conf). See `live/`.

**What is left is one operator broadcast, not a code seam:**
- **Provenance anchor:** committing the manifest root to the chain in an OP_RETURN is a
  spend, so the operator broadcasts it (`buildAnchorTx` produces the unbroadcast tx, or
  use the BSVKey on-chain tooling). The **anchor verifier is built** and confirms the
  root once an anchor txid exists (`ANCHOR_TXID=<txid> make live`).

Mission-latency contact plans (real Moon/Mars/Uranus delays) are a refinement on the
proven R2 path, not a seam.

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

## Open core vs. hosted service

This repository is the **open core** under Apache-2.0: the protocol, the agent library
(`agent/`), the DTN transport adapters (`transport/`, `m0/`, `r2/`), the verifiers, and
the live on-chain checks (`live/`). Use it, fork it, build on it.

What is **not** in this repository and is not covered by this license: a hosted BSV
settlement facilitator and relay marketplace, managed key custody, enterprise and
compliance features, and the BSVKey brand. Those are operated separately. The open core
settles on BSV; running a production relay-payment service on top of it is where the
hosted offering lives.

## Contributing and security

See [`CONTRIBUTING.md`](CONTRIBUTING.md) and [`SECURITY.md`](SECURITY.md). The keys and
funds in any live path are yours; this reference implementation never holds them.

---
Copyright 2026 Embryo Space Inc. (DBA BSVKey). Licensed under the Apache License 2.0.
See [`LICENSE`](LICENSE) and [`NOTICE`](NOTICE).
