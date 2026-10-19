# Proposals for draft-bsvkey-dtn-custody-receipt-block-02

Changes that the overhead and latency work (`docs/overhead-benchmark.md`) suggests, which
would need something beyond the -01 wire format. Nothing here is implemented in the block
224 code path. Version 2 receipts as specified in -01 (COSE_Sign1, EdDSA, SHA-256) are
unchanged, and the fast path in `transport/bpv7/fast-stamp.mjs` emits exactly -01 bytes.

## 1. Batch receipts: one signature per node per contact

**Problem.** Per-bundle receipts grow every bundle by 168 B at the first custodian and
156 B at each further one, and cost one signature per bundle per hop. With 1 KiB bundles the
receipts are 16% of the data. -01 section 8 lists batching as open: how a batch receipt is
carried is not specified.

**Proposal.** A custodian MAY, instead of appending a receipt to each bundle, fold every
bundle it takes custody of in a contact into a Merkle tree and sign one batch receipt when
the contact ends.

- Leaf: SHA-256(0x00 || CBOR [bundle identity, payload hash]) (content-bound), where bundle
  identity and payload hash are exactly as in a -01 receipt (keys 3 and 4). An
  identity-bound variant, SHA-256(0x00 || CBOR [bundle identity]), is cheaper but does not
  bind the payload bytes; if allowed, the receipt must say which rule it used.
- Tree: interior node SHA-256(0x01 || left || right), an odd last node paired with itself
  (as the reference implementation, `agent/lib/merkle.mjs`; built incrementally by
  `agent/lib/stream-merkle.mjs`).
- Batch receipt: COSE_Sign1 (EdDSA) over a CBOR map. The benchmark used keys 1 prevHop,
  2 thisHop, 5 window start, 6 window end, 8 bundle count, 9 Merkle root, 10 contact id.
  That map is 169 B as a COSE_Sign1.
- Carriage: as the payload of an administrative record (a new record type) sent toward the
  verifier, or kept at the node and served on request. A verifier proves one bundle with the
  batch receipt plus an inclusion proof (32 B per tree level: 640 B at a million bundles).
- Optional in-bundle pointer: a custodian in batch mode MAY add a short unsigned entry to
  block 224 naming its contact id, so a verifier knows whom to ask. That costs tens of bytes,
  not a signature, and is not evidence by itself.

**Gap audit.** It works as in -01. Batch receipts carry no per-bundle times, so the verifier
orders the custodians by following prevHop to thisHop. An unsigned stretch is a gap. A
payload changed after a custodian fails that custodian's inclusion proof. The optical ISL
sim (`constellation/optical-isl.mjs`) audits the same sample both ways and gets identical
results.

**Cost the verifier and node take on.** A node that must prove any bundle later keeps
32 bytes per bundle per contact. A verifier needs the batch receipt and a proof from each
custodian, not just the bundle.

## 2. Signing in parallel with transmission: not possible in BPv7, no change proposed

RFC 9171 section 4.1 makes the payload block the last block, and block 224 precedes it. So
the receipt must be complete before any payload byte is sent, and only the primary block and
earlier extension blocks can leave while the signature is computed. In the measured case
that is the 39 B primary block: 31 ns at 10 Gbps and 3 ns at 100 Gbps, against a 28.6
microsecond signature (`bench/latency.mjs`). The gain is not worth a format change. Batch
receipts (proposal 1) remove the signature from the forwarding path altogether instead.

## 3. Things that cut latency without a format change (done in -01 terms)

These are implementation guidance, possibly worth a short note in -02:

- Hash the payload and check its CRC incrementally as convergence-layer segments arrive,
  so both are ready when the last byte lands.
- Splice the new block 224 in before the payload and forward every other block as the
  bytes received. Do not decode and re-encode the bundle; that also keeps other blocks
  (and any BPSec signatures over them) byte-exact.
- Hand the convergence layer a gathering write (the payload as a view, not a copy).
- Precompute the constant parts of the COSE Sig_structure and of the receipt payload.

Measured effect is in `docs/overhead-benchmark.md`, section "Latency before forwarding".
