# From the IETF to CCSDS: where space agencies standardise DTN

The IETF DTN Working Group defines the Bundle Protocol. Space agencies then profile it for missions
through the Consultative Committee for Space Data Systems (CCSDS), whose recommendations are what
agency procurements and flight systems cite. Custody receipts become something missions can require
only through that second step.

## The CCSDS documents that matter here

As cited by the work we build on (verify each against public.ccsds.org before quoting it):

| Document | What it is | Cited by | Why it matters to receipts |
|---|---|---|---|
| CCSDS 734.20-O-1 | CCSDS specification of BPv7 | Hardy design notes | Intends to recommend integrity over the primary block; our BPSec code follows RFC 9173 erratum 9192 for exactly that case |
| CCSDS 734.5-R-2 | Draft BPSec profile (Red Book) | Hardy design notes | Requires the RFC 9173 security contexts for interoperability testing; our BIB code reproduces the RFC 9173 vectors (corrected A.3) |
| CCSDS 734.6-O-1 (June 2026) | Custody Transfer and Compressed Bundle Status Reporting | draft-koo-dtn-traceroute-eb | The agency side of custody transfer; receipts complement it the way they complement BIBE |
| CCSDS SABRE | Schedule-Aware Bundle Routing | draft-taylor-dtn-dpp | The routing that decides which custodians a bundle meets |

"O" books are orange (experimental), "R" are red (draft for review), "B" blue (recommended standard).

## How participation works

CCSDS members and observers are space agencies; companies take part through their national agency's
delegation (for a US company, normally NASA). The DTN work sits in the Space Internetworking Services
(SIS) area. So the practical routes are:

1. **Through people already there.** Several authors of the drafts around ours work for agencies
   that take part in CCSDS (TREB's author is at the Korea Aerospace Research Institute). Co-authoring
   with them carries the work into their agency's delegation.
2. **Through NASA.** A US company joins NASA's CCSDS delegation activities through a NASA sponsor or
   program; a SBIR or a mission contract that uses DTN is the usual way in.
3. **Through evidence first.** CCSDS works from interoperability testing. The four-stack results,
   BPSec alignment with the profile's required contexts, and an orange-book-ready description
   (CCSDS orange books describe experimental specifications) are what an agency delegate would need.

## Suggested sequence

1. IETF: list discussion and feedback on the receipt draft and the accountability framework.
2. A co-author from an agency or agency contractor.
3. With them, propose an experimental (orange book) profile of custody receipts in CCSDS SIS, or a
   section in an existing DTN book, citing the IETF draft.
4. Interoperability testing at a CCSDS DTN test event, using the open test suite.

## To check before anything is sent

- The exact titles, status and dates of 734.20, 734.5 and 734.6 on public.ccsds.org. NASA's
  LunaNet Interoperability Specification v5 (January 2025) cites the CCSDS BPv7 profile as
  734.2-P-1.1, to be published as 734.2-B-2, so check which number is current.
- Which agencies currently lead the SIS-DTN working group and who chairs it.
- Whether a US company can observe CCSDS meetings without a NASA sponsor.
