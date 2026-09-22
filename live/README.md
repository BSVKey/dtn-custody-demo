# live/ — the live settlement + provenance anchor seam

Turns the delivery receipt's placeholder into a **real, on-chain** payment and (once
anchored) tamper-evident provenance. Read-only verification is zero-dependency and runs
here; the one broadcast (creating the anchor) is a deliberate operator step, not done in
this repo.

## Settlement (proven, runnable)

`node live/run-live.mjs` binds a delivery receipt to a **real BSV mainnet settlement**
and verifies it on WhatsOnChain: the receipt names the txid the verifier paid
(`bindDelivery`), and that txid is confirmed on chain to pay `payTo` the amount
(`verifySettlementOnChain`). It also shows the refusals (a different txid, an unbound
check). Result against the pinned fixture settlement: PASS, 5942 sats, 2351+ conf.

In production the txid comes from `readSettlement(res).txid` of the payment made for the
delivery; here it is pinned so the check is reproducible.

## Provenance anchor (verifier built; creation is a broadcast you run)

- **Verify:** `verifyAnchorOnChain(txid, root)` confirms an OP_RETURN of `txid` carries
  the manifest root. Pass `ANCHOR_TXID=<txid>` to `run-live.mjs` to include it.
- **Create (broadcast):** anchoring the root is a spend, so you do it:
  1. `buildAnchorTx({ root, wif })` (needs `npm i @bsv/sdk` + a funded WIF) returns a
     signed `txhex` WITHOUT broadcasting; broadcast it via WhatsOnChain or your node.
  2. Or anchor the root with the existing BSVKey on-chain tooling (BSV Scribe).
  Then verify it with `ANCHOR_TXID=<txid> node live/run-live.mjs`.

## Full end-to-end story

`make r2` (payload over real µD3TN BPv7, custody held across a contact gap, verified) +
`make live` (delivery bound to a real on-chain settlement) together are the complete
loop, minus only the operator's one-time anchor broadcast. Run `MANIFEST_ROOT=<root>`
to bind the anchor check to a specific run's root.
