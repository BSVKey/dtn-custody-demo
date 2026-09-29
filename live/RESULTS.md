# Live results: the full loop on real BSV mainnet

`make live` (= `node live/run-live.mjs`, no env needed) proves both live halves against
real on-chain data:

```
== Live delivery check ==
  bind (verifier's own txid)   : PASS
  settlement on chain           : PASS (5942 sats to 1LdqUbdZ6GY71KxThU6aKfuKXxgmTn82cv, 2412 conf)
  provenance anchor             : PASS (60 conf)
  OVERALL                       : PASS
  refuses a different txid      : PASS
  refuses unbound               : PASS
```

## Pinned on-chain facts

- **Settlement** (delivery bound to a real payment):
  tx `77030c6192c6e86b808f1d7afa210b874bad86ed6a6b4ef69a8ccebc51ec83c6`,
  5942 sats to `1LdqUbdZ6GY71KxThU6aKfuKXxgmTn82cv`.
  https://whatsonchain.com/tx/77030c6192c6e86b808f1d7afa210b874bad86ed6a6b4ef69a8ccebc51ec83c6
- **Provenance anchor** (manifest root committed in an OP_RETURN):
  root `0xd7ad1d65771351d674699fa8296fe36883ef798486dff72a547aefc5d5dfe7cc`
  (the Merkle root of `anchored-payload.txt`),
  tx `733dcc21bb592ab70118fcd68f9e398dd0a51e135e0fe3570ab3ea3724b51207`.
  https://whatsonchain.com/tx/733dcc21bb592ab70118fcd68f9e398dd0a51e135e0fe3570ab3ea3724b51207
- **Earlier anchor (retired):** tx `d49777e46abe6dfa02586d3ab81f91c52fb9026dd667d6adafd848fa8889e8ca`
  anchored an earlier version of `anchored-payload.txt` (root `0xf06695f7…2911cb`). It
  stays valid on chain and re-derives from that version in the git history; the demo
  recording in `demo/` was made against it.

Re-derive the root by chunking `anchored-payload.txt` (64-byte chunks) and it matches
the value in the anchor's OP_RETURN.

## How it was produced

The anchor tx was built and signed locally by `live/build-anchor.mjs` from a throwaway
key (mnemonic-derived, `m/44'/236'/0'/0/0`), then **broadcast by the operator** (a
spend). The build step never broadcasts. The settlement is a pre-existing real mainnet
payment from the BSVKey fixtures.

## What this closes

The complete loop is now proven end to end on real infrastructure:
chunk -> Merkle -> real µD3TN BPv7 custody held across a contact gap (`r2/RESULTS.md`)
-> out-of-order verification -> custody chain -> gap object -> delivery bound to a real
on-chain BSV settlement -> manifest root anchored on-chain. No seams remain; mission-
latency contact plans are a refinement.
