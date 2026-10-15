# Custody Receipt Block: results (2026-10-14)

The custody chain rides inside the BPv7 bundle as extension block 193. Spec:
`spec/CUSTODY-RECORDS.md` section 2.1. Code: `cbor.mjs`, `bundle.mjs`, `custody-block.mjs`.

## 1. Unit tests (`node --test test/bpv7-custody-block.test.mjs`): 7 of 7 PASS

CRC check values, CBOR shortest form, two-hop append and verify, Previous Node block used
as the previous hop, byte-identical pass-through by a node that does not know the block,
tampering refused with a reason (bit flip, dropped receipt, receipts moved to another
chunk, no block), and flags that never ask a node to drop the bundle or the block.

## 2. Independent implementation (`interop/pyd3tn-check.py`, pyd3tn 0.15.1): PASS

```
1 PASS  pyd3tn re-serializes our 1073-byte bundle byte for byte (CRC-16 primary, CRC-16/32C blocks, block 193)
2 PASS  our decoder accepts pyd3tn's 188-byte bundle, block types [193, 6, 10, 1], all CRCs verified
```

pyd3tn's Python parser rejects unknown block types, so the check registers 193 with it.
The uD3TN node itself has no such limit (section 3).

## 3. Live, two unaware uD3TN nodes (`make bpv7-block`): PASS

Our gateway agent stamps hop 1 and sends the bundle over MTCP to uD3TN relaya, which
forwards to uD3TN relayb, which holds it until its contact to the destination opens.

```
[live] contacts: relaya->relayb at +1 s, relayb->dest at +6 s (relayb holds the bundle meanwhile)
[live] hop 1 (dtn://gateway-up.dtn/) stamped; bundle 2261 bytes, handed to uD3TN relaya
[mtcp] received a 2261-byte bundle on :4254
[live] delivered after 5 s
[live] sent blocks [193,1], received blocks [193,1] (uD3TN may add or update its own)
[live] custody block after two unaware uD3TN hops: byte-identical
[live] hop 2 (dtn://dest.dtn/) stamped; chain of 2: {"ok":true,"hops":2,"bundleId":"0x2fbb...a916"}
=== bpv7-block exit: 0 (0 = custody block carried intact by unaware uD3TN nodes, chain verified) ===
```

Not yet run: NASA HDTN, JPL ION and Hardy with the in-bundle block (they currently carry
the receipts as separate bundles), and a payload BIB alongside block 193.
