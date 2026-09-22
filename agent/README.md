# agent/

The application agent that runs at each node, on top of the BPv7 bundle agent. Three
roles (selected by `NODE_ROLE`):

- **source** (`role=source`): chunk the payload, build a Merkle tree, emit one BPv7
  bundle per chunk (leaf bytes + Merkle branch) plus a signed manifest bundle (root +
  metadata). Reuses the canonical hash route `id = sha256(canonical(...))` from the
  BSVKey receipt code.
- **relay** (`role=relay`): on receiving a bundle, before forwarding, emit a signed,
  content-addressed **custody receipt** `{prevHop, thisHop, bundleId, receivedAt,
  forwardedAt}` (compact BSM, same envelope as the shipped receipts). Optional per-hop
  micropayment (dev-mode).
- **dest** (`role=dest`): verify each chunk against the manifest root as it arrives,
  out of order (reject tampered); reassemble; verify the full custody chain; emit a
  delivery receipt bound to a real BSV settlement (`bindX402Receipt`); anchor the root
  on-chain; emit a **gap object** for any occultation window.

Reuse, do not re-implement: the canonical hashing, BSM signing/recovery, and
`bindX402Receipt` / `verifyX402ReceiptFull` come from `@bsvkey/x402-bsv-client` and the
broker's `x402-receipt` module. This agent is the DTN-specific glue around them.

Language: TBD at M1 (Node reuses the published client directly; Rust pairs with the
dtn7-rs fallback). See docs/BUILD-PLAN.md sections 2 and 5.
