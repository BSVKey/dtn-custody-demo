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
| Bundles over LTPCL or EPPCL on long-haul or periodically disrupted links (AOS or USLP) | **LTP tested with block 224:** receipt version 2 and a payload BIB crossed two JPL ION nodes joined by LTP over UDP, with the Earth-Moon light time (1,282 ms each way) on the link, and arrived byte-identical (see below). The earlier receipt format also crossed LTP at 240 s Mars light time ([mars/RESULTS.md](../mars/RESULTS.md)). **Not tested:** EPPCL, and AOS or USLP framing |
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
- **Light time:** the Earth-Moon distance comes from a lunar ephemeris at the moment of the contact ([lunar/ephemeris.mjs](../lunar/ephemeris.mjs), Meeus, *Astronomical Algorithms*, chapter 47). It reproduces Meeus's worked example to 0.1 km, and its 2026 range is 356,652 to 406,417 km, so the light time moves by about 165 ms between perigee and apogee.

```
== Destination audit (block 224, receipt v2) ==
  receipts verify under pinned provider keys: PASS (3 custodians)
  unsigned stretch reported, not inferred: after ipn:101.0, last unsigned node ipn:102.0, before ipn:201.0
  payload BIB (RFC 9173 HMAC-SHA2) still verifies after every append: PASS

== Light-time audit ==
  ipn:101.0 -> ipn:201.0: received 1012 ms after forward, light needs 10 ms  PASS
  ipn:201.0 -> ipn:301.0: received 1231 ms after forward, light needs 1214 ms  PASS
  floor = ephemeris distance less Earth's radius less the orbiter's 4737 km orbit radius, over c
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
- **Distances:** for the Earth link, the floor is the ephemeris distance at that moment, less the Earth's radius (the station may be on the near side), less the orbiter's greatest distance from the Moon's centre. That makes it a true lower bound wherever the station and orbiter are.

This check needs no change to the block or the draft: it reads the received and
forwarded times every receipt already carries.

## Over LTP with light time: `transport/bpv7/interop/ion-ltp-run.sh`

```
our gateway (ipn:1) --UDP--> ION ipn:10 --LTP over UDP, netem 1282 ms each way--> ION ipn:20 --UDP--> our destination (ipn:2)
```

Run 2026-10-19, JPL ION c5a4d87, each node in its own network and IPC namespace:

```
[ltp] link ipn:10 <-> ipn:20: LTP over UDP, netem delay 1.28s each way
[live] source added a BPSec BIB (BIB-HMAC-SHA2, HMAC 256, scope 7, MAC input rfc9173) over the payload
[live] hop 1 (dtn://gateway-up.dtn/) stamped with a version 2 receipt (COSE_Sign1); bundle 1964 bytes, handed to JPL ION nodes over LTP with Earth-Moon light time
[udp] received a 1984-byte bundle on :4558
[ltp] delivered 1728 ms after hand-off (one LTP crossing needs at least 1282 ms)
[live] sent blocks [11,224,1], received blocks [11,224,6,7,1] (the stack may add or update its own)
[live] custody block after two unaware JPL ION nodes over LTP with Earth-Moon light time: byte-identical
[live] BPSec BIB over the payload after hop 2 appended: verifies
[live] hop 2 (dtn://dest.dtn/) stamped, version 2 chain: {"ok":true,"complete":false,"custodied":2,"gaps":[{"afterHop":"dtn://gateway-up.dtn/","beforeHop":"dtn://dest.dtn/","lastUnsigned":"ipn:20.0"}],...}
=== bpv7-block-ion-ltp exit: 0 ===
```

The two ION nodes don't sign, so the destination reports that stretch as a gap and names
the last unsigned node, ipn:20.0, from ION's Previous Node block.

Reproduce: `make bpv7-block-ion-ltp` (or the `docker run` line at the top of the script).

## Limits

- **Software only:** this is a reference implementation, not flight software. Nothing here has flown or been tested on LunaNet provider hardware.
- **Convergence layers:** block 224 has not been tested over EPPCL, or over AOS or USLP framing.
- **Lunar-side geometry:** the surface and proximity distances are fixed, and the orbiter's greatest distance from the Moon is a parameter (4,737 km here, a low lunar orbit). A relay in a near-rectilinear halo orbit would need its own ephemeris.
- **Endpoint IDs:** `ipn` node numbers here are illustrative, not registered LunaNet IDs.
