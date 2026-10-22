# Accountable Solar System Internet: PASS

Run 2026-10-22. Reproduce: `make ssi` (`node ssi/run.mjs`, about a second) and
`node ssi/explorer.mjs` for the explorer page (`ssi/explorer.html`). Tests: `test/ssi.test.mjs`.

One simulated 72-hour run from 22 October 2026 that puts every piece of this repository in
one network:

- **Five independent operators**: a deep-space ground network (stations at the real
  Goldstone, Madrid and Canberra coordinates), two commercial lunar relay operators (A with
  two orbiters and its own ground station; B with one orbiter and **no custodian**), a Mars
  relay operator, and the science mission that owns the data (a far-side lunar lander, a Mars
  rover, mission operations).
- **Contacts from geometry, not typed in**: Moon and Mars positions from low-precision
  ephemerides, Earth stations turning with the Earth, relay orbits, a 10-degree elevation mask,
  occultation by the Earth, Moon and Mars. 356 contact windows, each with its own light time:
  1.22 to 1.30 s to the Moon, 12.4 to 12.6 minutes to Mars. The far-side lander never sees
  Earth; it is reached only through the lunar relays.
- **Signed schedules**: each operator signs the contact plan for the links it transmits on
  (`dtn.contact-plan/1`, with ION and HDTN exports); all five verify.
- **Real bundles**: BPv7 bundles routed hop by hop by contact graph routing (earliest
  arrival), with a Hop Count block, a custody receipt (v2, fields 8 and 9) at every signing
  node, and key news carried in block 225.
- **Each node knows only what reached it**: every node has its own keyring; the ground hears
  from operators at once, spacecraft only through traffic.

## Traffic

| Flow | Sent | Delivered | Median / worst latency |
|---|---|---|---|
| Far-side lander telemetry, 20 kB every 2 h | 24 | 24 | 0.00 / 0.98 h |
| Mars rover images, 150 kB every 4 h | 12 | 12 | 2.88 / 7.57 h |
| Commands to the lander, 2 kB every 6 h | 8 | 8 | 0.00 / 0.98 h |
| Commands to the rover, 2 kB every 6 h | 8 | 8 | 3.85 / 5.15 h |

52 of 52 delivered, 186 custody receipts. Contact graph routing sent 14 of the 20 Mars
bundles direct to Earth at 1 to 2 kbps rather than wait for the short relay-orbiter passes (5
in 72 hours, minutes each); it is a routing outcome of these rates, not a rule.

## A relay key is stolen

The key of lunar relay A-2 is copied at +14 h. Its operator revokes it at +20 h, effective
from the theft, and issues a replacement. The ground has both records at once; spacecraft
hear only through bundles that pass them.

| Node | Heard the revocation after detection |
|---|---|
| Mission operations, three deep-space stations, operator A ground | at once |
| Lunar relay B-1 (operator B) | 4.5 h |
| Far-side lander | 4.5 h |
| Lunar relay A-1 | 6.5 h |
| Mars rover | 9 h |
| Lunar relay A-2 (the victim, which then switches to its new key) | 10.5 h |
| Mars relay orbiter | 22.7 h |

One delivery carried A-2's old key from after the theft; mission operations refused it
(`signed_after_revocation`). No destination accepted a stolen-key receipt in this run.

The attacker then bills for carriage with the stolen key. Every claim is refused for its
own reason:

| Forged claim | Clearing |
|---|---|
| Receipt appended to a real delivery, backdated before the theft | `revoked_unwitnessed` |
| Receipt spliced in ahead of the destination's receipt | `chain_digest_mismatch` (whole claim refused) |
| Receipt signed at its true time, after the theft | `signed_after_revocation` |
| A bundle that was never delivered | `bundle_never_delivered` |
| An honest delivery submitted a second time | earns nothing extra |

## Settlement between operators

Clearing judges each receipt on its own (its place in the chain, signature, key validity and
revocation at the time it claims, a witness for keys revoked later), credits each
(bundle, custodian) once at the operator's rate per MB, and signs one statement per operator
(`ssi.settlement/1`, with a Merkle root of the credited receipts). All statements verify.

| Operator | Bundles | MB | Rate per MB | Amount | Receipts refused |
|---|---|---|---|---|---|
| Deep-space ground network | 47 | 2.212 | 0.5 | 1.106 | 0 |
| Lunar relay operator A | 28 | 0.452 | 2.0 | 0.904 | 3 (two forgeries, one honest loss) |
| Lunar relay operator B (no custodian) | 0 | 0 | 1.5 | 0 | 0 |
| Mars relay operator | 6 | 0.604 | 8.0 | 4.832 | 0 |

Operator B's relay carried 8 hops. The hop count reports each as one unsigned node between
two custodians, so the carriage is visible but cannot be billed: the receipt is the invoice.
Operator A lost one honest receipt, signed by A-2 between the theft and its key switch; a
key cannot be told apart from its thief inside the compromise window.

## Limits

- Simulation in virtual time. Positions are low-precision (the Moon's direction to about
  0.3 degrees, Mars to well under a degree), links are idealized (no bit errors, no pointing,
  a fixed rate per link), and relay orbits are circles in the plane through the Earth line.
- Operators are generic; rates and prices are illustrative. Amounts are in an abstract unit;
  no payment is made (the repository's settlement runs on Bitcoin BSV are in
  `constellation/` and `live/`).
- Routing is earliest-arrival contact graph routing re-run at each node, without volume
  reservation beyond the first hop.
- Per-run keys are random, so receipt ids and statement ids change between runs; the
  outcomes do not.
