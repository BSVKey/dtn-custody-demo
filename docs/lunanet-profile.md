# Custody receipts on LunaNet: a profile

How the Custody Receipt Block (extension block 224, receipt version 2,
[draft-bsvkey-dtn-custody-receipt-block](https://datatracker.ietf.org/doc/draft-bsvkey-dtn-custody-receipt-block/))
fits the DTN services in NASA's LunaNet Interoperability Specification, and what has and
has not been tested.

Source: LunaNet Interoperability Specification, Version 5 (LNIS V005, 29 January 2025),
section 3.1.2 "DTN Network Communications Services" and Table 4. Check against the current
LNIS before quoting; later versions may change the applicable documents.

## What LNIS v5 requires, and where receipts sit

| LNIS v5 (section 3.1.2) | Custody receipts |
|---|---|
| BPv7 "shall be used" (CCSDS profile of RFC 9171, cited as CCSDS 734.2-P-1.1, to be published as 734.2-B-2) | Block 224 is a BPv7 extension block. Forwarders that don't implement it carry it unchanged (RFC 9171 block processing flags: replicate in every fragment, never delete the bundle or discard the block) |
| Bundles over TCPCL or UDPCL when nodes are joined by IP | The block is inside the bundle, so the convergence layer does not see it. Tested: UDP (JPL ION), TCP-based layers (µD3TN, NASA HDTN), Hardy's CLA API ([RESULTS.md](../transport/bpv7/RESULTS.md) sections 3 and 6) |
| Bundles over LTPCL or EPPCL on long-haul or periodically disrupted links (AOS or USLP) | LTP carries bundle bytes opaquely. Tested: LTP over UDP with 240 s one-way light time ([mars/RESULTS.md](../mars/RESULTS.md)), with the earlier receipt format. **Not yet tested:** block 224 over LTP, and EPPCL at all |
| BPSec (RFC 9172), CCSDS profile being finalized | A payload BIB (RFC 9173 HMAC-SHA2) beside block 224 still verifies after every append. Our BIB code reproduces the RFC 9173 vectors, including the corrected Appendix A.3 of erratum 9192 |
| Custody transfer and QoS extensions "currently being defined" as CCSDS Orange Books | Receipts don't replace custody transfer. Custody transfer decides who must retransmit; receipts record who held the bundle and when, for audit between providers afterwards |
| Routing on pre-scheduled links, details in provider ICDs | Receipts record the route actually taken, including stretches where a node forwarded without signing |
| Addresses and IDs registered through SANA and IANA (section 3.1.3) | Block 224 is in the experimental range. A permanent block type would be requested from IANA (the draft's TBD1) once the DTN Working Group shows interest |

## Why LunaNet needs this

LunaNet is built around many providers: lander operators, relay orbiters and ground
networks run by different companies and agencies. Each one holds a user's data for
seconds to hours, through occultations and scheduled contacts. Afterwards, the user and
the providers need to agree on:
- who held each bundle, and for how long
- where it waited, and why
- whether a late delivery happened inside a documented outage

Each provider's own logs can't settle that between parties. Receipts that travel in the
bundle, signed by each provider's key and checkable offline by anyone, can.

## The run: `node lunar/run.mjs` (tests: `node --test test/lunar.test.mjs`)

The run uses the real block 224 code path, with no simulation of the receipts themselves.

- **Route:**
  1. lander (provider A, signs)
  2. surface relay (forwards without signing)
  3. lunar relay orbiter (provider B, signs, holds the bundle through a 47-minute far-side occultation)
  4. Earth ground station (provider C, signs)
  5. mission operations
- **BPSec:** a payload BIB is added at the source.
- **Light time:** one-way light time is computed from distance: 1,282 ms Earth-Moon at the mean distance of 384,400 km.

```
== Destination audit (block 224, receipt v2) ==
  receipts verify under pinned provider keys: PASS (3 custodians)
  unsigned stretch reported, not inferred: after ipn:101.0, last unsigned node ipn:102.0, before ipn:201.0
  payload BIB (RFC 9173 HMAC-SHA2) still verifies after every append: PASS

== Light-time audit ==
  ipn:101.0 -> ipn:201.0: received 1012 ms after forward, light needs 10 ms  PASS
  ipn:201.0 -> ipn:301.0: received 1283 ms after forward, light needs 1282 ms  PASS
  ground station backdates its receipt by 900 ms: signatures still verify (PASS), timing audit catches it (PASS)

  bundle on arrival: 4765 bytes, including three receipts
```

### New here: the light-time audit

A signature proves who made a claim, not that the claim is possible. The light-time
audit (`auditLightTime` in [lunar/lunanet.mjs](../lunar/lunanet.mjs)) checks each pair of
consecutive receipts. A custodian can't have received a bundle sooner after the previous
custodian forwarded it than light needs to cover the distance between them. A provider
that backdates a receipt, say to dodge a late-delivery penalty, is caught even though its
signature is genuine.

- **Clock tolerance:** providers' clocks must agree to within a tolerance, 50 ms by default. LunaNet's common time service is what makes that tolerance realistic.
- **Distances:** the audit takes the minimum delay for each link from the contact plan or ephemeris. This run uses fixed distances.

This check needs no change to the block or the draft: it reads the received and
forwarded times every receipt already carries.

## Limits

- **Software only:** this is a reference implementation, not flight software. Nothing here has flown or been tested on LunaNet provider hardware.
- **Convergence layers:** block 224 has not yet been tested over LTP (only the earlier receipt format has), or over EPPCL with AOS or USLP framing.
- **Distances:** the run uses fixed link distances. A real audit would take each link's minimum light time from the contact plan or ephemeris at the time of the contact.
- **Endpoint IDs:** `ipn` node numbers here are illustrative, not registered LunaNet IDs.
