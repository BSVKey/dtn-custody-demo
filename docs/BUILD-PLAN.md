# DTN Custody + Payment Demo: Design and Build Record
### A BSVKey / Embryo Space reference implementation

**Purpose.** A runnable, end-to-end demonstration of the verifiable data custody +
relay-payment layer over an emulated delayed/disrupted link: a chunked payload crosses
a multi-hop DTN with an occultation blackout, and every chunk is verified against a
Merkle root, a signed custody receipt is stamped at each hop, a gap object is recorded
across the blackout, and delivery is settled with a micropayment.

**One-line scope.** `chunk → Merkle → BPv7 bundles → multi-hop store-and-forward
with a scripted occultation → out-of-order Merkle verification → per-hop custody
receipts → gap object across the blackout → delivery bound to a real BSV settlement
→ provenance anchor.` Physical RF layer is explicitly out of scope.

---

## 1. Architecture

### Topology (4 nodes, containerized)
```
[Source: rover]──L1──[Relay A: orbiter]──L2──[Relay B: ground-relay sat]──L3──[Dest: Earth GS]
```
Each node is a container (Docker/Podman). Links `L1..L3` are `veth` pairs shaped with
Linux `tc netem` for one-way delay, loss, jitter, and reordering. Link up/down is
scripted from a **contact plan** to emulate line-of-sight and occultation.

### Two layers, kept separate
1. **Transport: standard BPv7 (RFC 9171).** We do not reinvent DTN. Bundles carry our
   payload between nodes with store-and-forward and scheduled-contact routing.
2. **Custody + verification + payment: our application agent.** A bundle application
   that runs at each node and does the custody + verification + payment work. This is
   the novel part, and it sits *on top of* BPv7 so it is portable across DTN stacks.

**Design choice that is also a selling point:** custody is an
**application-layer, cryptographic** construct (a signed, content-addressed receipt),
not BPv7's native custody signals. Native custody transfer is inconsistent across
implementations and not cryptographically verifiable offline; ours is portable and
verifiable a session late, which is exactly the deep-space requirement.

### DTN stack choice
- **Primary: µD3TN** (D3TN GmbH, BPv7, C, lightweight, flight heritage on ESA
  OPS-SAT). Its Application Agent Protocol (AAP) is a clean seam to attach our agent.
- **Fallback: dtn7-rs** (Rust BPv7, REST/WebSocket application interface, very
  hackable). Use if µD3TN's AAP integration proves fiddly inside the timebox.
- Routing: scheduled-contact routing / Contact Graph Routing so the occultation
  window is a first-class scheduled outage, not just dropped packets.

---

## 2. The application agent (what we actually build)

### At the Source (rover)
- Take a payload (start with a rover still image, then a short H.264 clip).
- **Chunk** into fixed-size blocks (and, for video, note GOP-aligned chunking so a
  verified prefix is playable).
- Build a **Merkle tree** over the chunks; the root + metadata (payload id, chunk
  count, codec, capture time) become a signed **manifest**.
- Emit one BPv7 bundle per chunk (leaf bytes + its Merkle branch) plus one manifest
  bundle. Reuse the existing canonical hashing: `leafId = sha256(canonical(chunk meta + bytes))`, same route as the BSVKey receipts.

### At each Relay (orbiter, ground-relay sat)
- On receiving a bundle, before forwarding, emit a signed **custody receipt**:
  `{ prevHop, thisHop, bundleId, receivedAt, forwardedAt }`, content-addressed and
  signed with that node's key (compact BSM, the same envelope as the shipped
  receipts). This is the verifiable custody chain.
- Optionally settle a **per-hop micropayment** to the prior hop for carrying the
  bundle (dev/regtest in the demo; see §4).

### At the Destination (Earth ground station)
- Verify each chunk against the manifest's Merkle root **as it arrives, out of
  order**; reject a tampered chunk (fails its branch).
- Reassemble; verify the **full custody chain** (each hop's receipt recovers to that
  hop's pinned key; the chain is continuous; a forged or missing receipt is caught).
- Emit a final **delivery receipt** and **bind it to a real BSV settlement** using the
  shipped `bindX402Receipt` / `verifyX402ReceiptFull` (settlementRef == the txid paid;
  an unbound verify refuses).
- **Anchor** the manifest root on-chain once (OP_RETURN via the existing on-chain
  tooling) = tamper-evident provenance of the dataset.

### Across the occultation window
- The contact plan drops `L2` (or `L3`) for a scripted interval. Bundles queue at the
  upstream relay (store-and-forward).
- The agent detects the outage and emits a first-class **gap object**:
  `{ link, downAt, upAt, bundlesDelayed:[...], bundlesLostConfirmed:[...] }`. On link
  reopen, delivery resumes and the gap object is reconciled against what actually
  arrived. Silence is documented, never read as "nothing happened."

---

## 3. What it proves (acceptance criteria, all testable)

1. **Out-of-order integrity.** With `netem` reordering + loss, every delivered chunk
   verifies against the Merkle root; a single flipped byte is rejected. (Deterministic
   unit test + full-run assertion.)
2. **Custody chain.** A 3-hop custody chain reconstructs and verifies; a forged hop
   receipt, a dropped hop, or a reordered hop is detected with a specific reason.
3. **Gap object.** The occultation produces a gap object with correct `downAt/upAt`
   and the exact set of delayed bundles; post-reopen reconciliation matches delivery.
4. **Payment binding.** Delivery is bound to a settlement: matching `settlementRef`
   passes, a different one returns `settlementRef_not_mine`, unbound refuses. (Reuses
   the shipped, tested binding.)
5. **Provenance.** The manifest root is anchored in one on-chain tx; re-deriving the
   root from the received payload matches the anchored value.
6. **Reproducible.** Runs headless in CI with compressed delays (offline, deterministic
   except the one anchor/settlement), plus a `--live` mode with real mainnet anchor.

---

## 4. Payment + anchor: real but cheap

Per-hop micropayments at true deep-space latency are philosophically fine (settlement
is store-and-forward, never a live channel), but paying real mainnet fees on every hop
of every demo run is wasteful. So:
- **Per-hop:** dev/regtest or the broker's existing dev-mode payment path. Fast, free,
  proves the mechanism.
- **Final delivery + provenance anchor:** **one real BSV mainnet settlement + one real
  anchor tx**, pinned like the existing fixtures. Mostly deterministic/offline, one
  live anchor: the exact pattern the ASM fixtures already use.

This keeps the demo honest (real chain where it counts) and runnable for free in CI.

---

## 5. Milestones (≈7–9 weeks, one engineer)

| M | Deliverable | Est. |
|---|---|---|
| **M0** | Containerized 4-node BPv7 testbed (µD3TN or dtn7-rs) with `netem` shaping + a scriptable contact plan / occultation window. | 1–2 wk |
| **M1** | Source chunker + Merkle manifest + destination out-of-order verifier (tamper-reject). Reuses the canonical hash route. | 1–2 wk |
| **M2** | Per-hop signed content-addressed custody receipts + chain verifier. | 1 wk |
| **M3** | Occultation detection + gap object + link-reopen reconciliation. | 1 wk |
| **M4** | Delivery bound to a BSV settlement (dev per-hop, one live delivery) reusing `x402-receipt` / `bindX402Receipt`. | 1–2 wk |
| **M5** | Provenance anchor, one-command demo harness, CI, a recorded run, and a short results/paper doc. | 1 wk |

Critical path: M0 → M1 → (M2, M3 parallel) → M4 → M5. M2 and M3 are independent once
the manifest exists.

---

## 6. Repo and deliverables

- Repo `dtn-custody-demo` (BSVKey org, or EmbryoSpace), MIT.
- `docker-compose.yml` testbed; `Makefile` / one-command `make demo`.
- `agent/` (source chunker, relay custody, destination verifier) with unit tests.
- `contact-plans/` (per mission tier: Moon 1.3 s, Mars compressed, Uranus compressed,
  each with an occultation window).
- `RESULTS.md` (the six acceptance criteria, with the pinned settlement + anchor tx
  links), an asciinema/MP4 of a run, and a 2-page paper-style writeup.

---

## 7. Risks and mitigations

| Risk | Mitigation |
|---|---|
| BPv7 stack integration friction | Two vetted options (µD3TN primary, dtn7-rs fallback); M0 de-risks this first. |
| Time-compression fidelity | Document that delays are scaled; provide one real-latency (Moon 1.3 s) run alongside compressed deep-space runs. |
| "Blockchain per hop" skepticism at deep-space latency | Frame explicitly as store-and-forward settlement, never a live channel; per-hop is dev-mode, one real settlement at delivery. |
| Scope creep into the physical layer | Hard boundary stated up front; the demo asserts nothing about RF/coding. |

---

## 8. Immediate next actions

1. Pick µD3TN vs dtn7-rs (recommend a 2-day M0 spike on µD3TN first).
2. Stand up the 4-node `netem` testbed with one scripted occultation. That single
   artifact (a payload surviving a blackout and reassembling) is already a compelling
   3-minute demo before any of the crypto layer lands.
3. Wire M1 on top, reusing the existing canonical-hash + receipt code.

*A reference implementation by Embryo Space Inc. (DBA BSVKey). Licensed under Apache-2.0.*
