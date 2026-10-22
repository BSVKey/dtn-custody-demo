# Accountable Solar System Internet on real BPAs (Aalyria Hardy): PASS

Run 2026-10-22. Reproduce: `make ssi-hardy` (Docker, about 13 minutes). The same network as
`ssi/RESULTS.md`, with every spacecraft and station a real Bundle Protocol agent:

- **Ten Hardy BPAs** (Aalyria's Hardy built with our custody-receipt filter, an Egress
  Rewriter that signs receipt v2 into block 224 inside the BPA): Goldstone, Madrid and
  Canberra, operator A's Hawaii station, lunar relays A-1, A-2 and B-1, the Mars relay
  orbiter, the far-side lander and the Mars rover. Relay B-1 runs without the filter.
- **Ten routing agents** (hardy-tvr), one per BPA, each fed a schedule of next hops compiled
  offline by contact graph routing from the contacts computed from geometry. Hardy holds
  bundles in its own store while no route is open and forwards when one opens.
- **Emulated space links**: one process attached to every BPA through Hardy's gRPC
  convergence-layer API carries each forwarded bundle across its link only while the
  contact is open, with the link's light time and rate. It is the emulator, like netem in the
  Mars runs; routing, storage and signing are Hardy's.
- **Endpoints**: mission operations and the lander and rover payload computers (JS, on local
  links) originate bundles with the first receipt and verify whole chains on arrival with
  their own keyrings, which start from the operators' root keys.
- **Time** is compressed 120 times: 24 scenario hours in 12 minutes of wall time. Light times
  and rates scale with it.

## Results

Two full runs: before and after adding receipt keys 8 and 9 to Hardy's filter.

| | Run 1 (filter as in draft -01) | Run 2 (filter signs keys 8 and 9) |
|---|---|---|
| Bundles delivered | 20 of 20 | 20 of 20 |
| Forwards between BPAs and endpoints | 53 | 53 |
| Receipts signed inside Hardy / by JS endpoints | 50 / 40 | 50 / 40 |
| Chains verified at the destination | 19 (one refused, below) | 19 (one refused, below) |
| Unsigned stretch through relay B-1 | named (Hardy's Previous Node block) | named and sized: 1 unsigned node, from Hardy's own key 8 |
| Key 9 from Hardy checked against the earlier receipts | n/a | every bundle, no mismatch |

Routes taken through the real BPAs varied with the geometry: lander telemetry through relay
A-1, A-2 or B-1 to Goldstone, Madrid, Canberra or operator A's Hawaii station; rover data
mostly direct to Madrid or Goldstone, once through the Mars relay orbiter (6.4 scenario
hours, waiting in Hardy's store for passes).

```
lander-tlm-0.5     verified  signers ipn:51.0 > ipn:50.0 > ipn:20.0 > ipn:10.0 > ipn:1.0
cmd-lander-1.5     verified  signers ipn:1.0 > ipn:10.0 > ipn:50.0 > ipn:51.0  gap: last unsigned ipn:30.0, 1 node(s)
lander-tlm-8.5     verified  signers ipn:51.0 > ipn:50.0 > ipn:21.0 > ipn:22.0 > ipn:1.0
lander-tlm-10.5    REFUSED signed_after_revocation  signers ipn:51.0 > ipn:50.0 > ipn:21.0 > ipn:12.0 > ipn:1.0
rover-img-17       verified  signers ipn:61.0 > ipn:60.0 > ipn:40.0 > ipn:12.0 > ipn:1.0
```

## The stolen key, on real BPAs

Relay A-2's signing seed is taken at scenario +6 h; its operator revokes the key at +10 h,
effective from the theft. Mission operations holds the revocation at once and passes it on
in the key record block of every command it sends.

- lander-tlm-10.5 crossed A-2 after the theft: Hardy on A-2 signed with the stolen key, and
  mission operations refused the chain (`signed_after_revocation`).
- lander-tlm-8.5 also crossed A-2 after the theft but arrived before the revocation was
  published: mission operations accepted it then; clearing, later, refuses A-2's receipt in
  it. Together these are the two honest receipts A-2's operator cannot bill: a key cannot be
  told apart from its thief inside the compromise window.
- The thief's forged claims: a receipt appended to a real delivery and backdated before the
  theft (`revoked_unwitnessed`), and one signed at its true time (`signed_after_revocation`).

## Revocations spread by Hardy itself

Hardy's filter can also gossip revocations (`gossip-revocations: true`, Hardy commit 191d4d30):
a second Egress Rewriter learns the revocation records arriving in any bundle's Key Record
Block and adds the ones it knows to every bundle it forwards. To show that Hardy, not our
endpoints, did the spreading, the final run (`ENDPOINT_RELAY=0`) had the lander and rover
payload computers learn key news but never pass it on; only mission operations sends it.

| | Result |
|---|---|
| Bundles that arrived carrying the revocation | 5 |
| Of those, left their origin without it and picked it up from a Hardy node | 3: lander-tlm-14.5, lander-tlm-16.5, rover-img-17 |
| Lander and rover payload computers heard of it | 3.5 and 4.2 scenario hours after it was issued |

The lander and rover BPAs learned the revocation from commands that had passed through them
earlier, then added it to the telemetry they forwarded. Everything else as in runs 1 and 2:
20 of 20 bundles, 50 receipts signed inside Hardy, the stolen-key delivery and both forgeries
refused. Live page: https://dtn.bsvkey.com/ssi/hardy/.

## Settlement from the receipts

| Operator | Bundles credited | Amount | Receipts refused |
|---|---|---|---|
| Deep-space ground network | 19 | 0.211 | 0 |
| Lunar relay operator A | 8 | 0.248 | 4 (two forgeries, two in the theft window) |
| Lunar relay operator B (no filter) | 0 | 0 | 0 |
| Mars relay operator | 1 | 0.400 | 0 |

## Paying the operators on Bitcoin BSV

`ssi/hardy/pay.mjs` turns the clearing house's signed statements into one mainnet payment:
each statement is verified (signature, clearing-house key, operator) before anything is built;
one output per operator at an address derived from the funding key (sweepable by its holder);
an OP_RETURN `ssi-settlement/1` with the Merkle root of the statement ids it pays. Amounts
convert at 10,000 sats per unit. Sent on Bitcoin BSV mainnet 2026-10-22, transaction
[884c01fa6cbdb797f9e6be1c58be1b8c8249a6a816bdee1fd8989a34f3fb8793](https://whatsonchain.com/tx/884c01fa6cbdb797f9e6be1c58be1b8c8249a6a816bdee1fd8989a34f3fb8793)
(accepted by ARC as SEEN_ON_NETWORK): 2,110, 2,480 and 4,000 sats to the three operators, the
OP_RETURN, and 33,969 sats change to the funding address. The run's output:

```
statements verified: ground 0.211 -> 2110 sat, lunaA 0.248 -> 2480 sat, marsnet 0.4 -> 4000 sat
commitment (Merkle root of 3 statement ids): 1f3f3396c87a22d1c6158929e12a1bd06f89d0b894cc57c7ff72b91a0f4cd7fa
txid 884c01fa6cbdb797f9e6be1c58be1b8c8249a6a816bdee1fd8989a34f3fb8793, fee 36 sat at 100 sat/kB, 354 bytes
SENT 884c01fa6cbdb797f9e6be1c58be1b8c8249a6a816bdee1fd8989a34f3fb8793 via https://arc.gorillapool.io (SEEN_ON_NETWORK)
```

Operator B gets no output: it signed nothing, so it has no statement.

## Limits

- The space links are emulated (contact windows, light time and rate enforced by one
  process); the BPAs, routing agents, storage and signing are real Hardy processes.
- Routing schedules are computed offline by our CGR and loaded into Hardy's time-variant
  routing agent; Hardy does not run CGR itself.
- Hardy carries revocations without verifying them (verification stays with whoever acts on
  a key); key records other than revocations are carried by the JS endpoints only.
- Time compressed 120 times; amounts in an abstract unit, no payment made.
- The Hardy filter changes (keys 8 and 9: commit 2e7f1ef4; gossip: 191d4d30) are on the local
  branch custody-receipt-filter of the Hardy checkout; not yet offered upstream.
