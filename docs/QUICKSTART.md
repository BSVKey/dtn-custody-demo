# Quickstart: verifiable custody in five minutes

For teams that move data over links that drop out: satellite and ground-station
operators, remote clinics and field sensors, disaster-response networks. The agent proves,
offline, that what arrived is exactly what was sent, which nodes held it on the way, and
that delivery was paid for. It runs beside any BPv7 node and has no dependencies.

## 1. Install

Node 18 or later.

```bash
npm install github:BSVKey/dtn-custody-demo
```

or clone it and run the example:

```bash
git clone https://github.com/BSVKey/dtn-custody-demo && cd dtn-custody-demo
node examples/quickstart.mjs
```

```
chunks verified:   6/6
custody chains:    all intact
payload intact:    true
delivery bound:    true (receipt 0x...)
```

## 2. The four calls

```js
import { genKeypair, prepare, makeRelay, makeDest } from "dtn-custody-demo";
```

| Role | Call | What it does |
|---|---|---|
| any node | `genKeypair()` | Ed25519 identity. Persist it with `exportKeypair` / `importKeypair`. |
| source | `prepare(kp, bytes, { payloadId, chunkSize })` | Chunks the payload, builds the Merkle tree, signs the manifest. Returns `{ manifest, bundles }`, one bundle per chunk. |
| relay | `makeRelay(kp, eid).stamp(bundle, prevHop, receivedAt, forwardedAt)` | Signs a custody receipt for a bundle it held. |
| destination | `makeDest(kp, manifest, pinnedHops, { sourcePub })` | Verifies each chunk against the root in any order (`receiveBundle`), checks custody (`recordCustody`, `verifyChain`), reassembles, and binds delivery to its own payment (`settle`). |

[`examples/quickstart.mjs`](../examples/quickstart.mjs) wires them together in about 40 lines.

## 3. Rules the verifier enforces

These are deliberate. Do not work around them.

- **Keys are pinned by the verifier.** `sourcePub` and every hop's `pub` come from your
  own configuration, never from the data. A missing `sourcePub` refuses (`unpinned`).
- **A tampered chunk is rejected, not stored** (`leaf_hash_mismatch`,
  `merkle_branch_invalid`).
- **A forged, missing or out-of-order hop breaks the chain** (`signer_not_pinned_hop_key`,
  `wrong_hop_count`, `custody_chain_break`).
- **Delivery binds only to the settlement you made.** Pass the txid from your own payment
  as `expected.settlementRef`; another txid refuses (`settlementRef_not_mine`), none
  refuses (`unbound`).

## 4. Connect it to a real network

| You run | Start here |
|---|---|
| µD3TN, NASA HDTN, JPL ION or Aalyria Hardy | [`transport/bpv7/`](../transport/bpv7/): receipts carried inside the bundle as extension block 224 (unaware nodes forward it unchanged) |
| A ground station, no flight change | [`ground/`](../ground/): station-signed ledgers from files you already receive |
| Flight software | [`flight/`](../flight/): the same signer in C99, plus a NASA cFS app |
| A large constellation | [`constellation/`](../constellation/): batch receipts, one signature per contact |
| Real BSV settlement and anchoring | [`live/`](../live/): your keys and funds stay yours |

The record formats and test vectors are in [`spec/CUSTODY-RECORDS.md`](../spec/CUSTODY-RECORDS.md).
To talk about integrating it, open an issue.
