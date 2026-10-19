# The Custody Receipt Block as a per-hop block: a case study

Written as input to the DTN working-group discussion on per-hop blocks, and in particular to the
block lifecycle model described in Hardy's design notes (`bpv7/docs/TODO.md`, "BPSec per-hop paper
audit ledger"): *a node that must change or remove a block is the acceptor of every security
operation on it, and the security source of any protection on the block that replaces it.*

The Custody Receipt Block (`draft-bsvkey-dtn-custody-receipt-block-01`) is a per-hop block of a
kind the RFC 9171 blocks do not cover. This note says how it fits the model, where it differs,
and what it suggests for the paper.

## Three kinds of per-hop block

| Kind | Examples | What a node does | Where integrity comes from |
|---|---|---|---|
| Replaced | Previous Node | Overwrites the value | BPSec on the new value, sourced by the node that wrote it; ends at the next node |
| Updated | Hop Count, Bundle Age | Rewrites the value from the old one | Same as above |
| **Appended, entries self-signed** | Custody Receipt Block; a signed TREB hop-record list | Adds one entry; never changes earlier ones | **Inside each entry**: a COSE_Sign1 by the node that added it, verifiable end to end |

The first two kinds lose end-to-end integrity by construction: each node's protection lasts one hop.
The third keeps it, because nothing a later node does touches an earlier node's signed entry.

## How it fits the lifecycle model

- **The node that changes the block is the acceptor of operations on it.** True, and vacuous here:
  the draft forbids any BIB or BCB from targeting the block (a BIB because every custodian appends
  to it, a BCB because later custodians must read it). So there is never an operation to accept,
  and no re-signing or re-encryption step.
- **The node is the source of protection on the replacement.** The appending custodian protects
  only its own entry, with its own key, as an object-level signature rather than a BPSec operation.
  It does not, and cannot, vouch for earlier entries; each verifies on its own.
- **Forwarders that do not implement the block** keep it unchanged (flags: replicate in every
  fragment; never delete the bundle or discard the block if unprocessed). They are outside the
  lifecycle entirely, which matches the model's scope: it governs nodes that change a block.

Tested: carried byte-identical through µD3TN, NASA HDTN, JPL ION and Hardy, with a payload BIB
beside it that still verifies after every append (`transport/bpv7/RESULTS.md`).

## What it suggests for the paper

1. **Name the append-only, self-signed pattern.** It is the one per-hop shape that keeps
   end-to-end integrity without a BPSec operation outliving a hop. Diagnostic per-hop data (TREB)
   could adopt it as an option, which is what `transport/bpv7/treb-signed.mjs` sketches: TREB's
   7-field hop-record unchanged, plus an optional detached COSE_Sign1 bound to the bundle identity
   and payload hash through external AAD.
2. **State that such blocks must not be BIB or BCB targets.** For the RFC 9171 per-hop blocks the
   model handles operations on them; for an append-only block the simpler rule is that none may
   exist, which also removes the "encrypted BIB over a per-hop block" cases the ledger works through.
3. **Fragments.** Replicate-in-every-fragment applies; an entry made before fragmentation names the
   whole bundle and covers each fragment, while a node holding a fragment signs for that fragment
   (the draft's section 3.4). The model may want a sentence on per-hop blocks under fragmentation.
4. **Rewriters.** Hardy's filter design lets a Rewriter add a per-hop block that travels as written.
   A Rewriter that appends a custody receipt would make the block native to a BPA without core
   changes, which is the second implementation the draft needs.

## Status

Open source (Apache-2.0): https://github.com/BSVKey/dtn-custody-demo. Offered as input; nothing here
assumes the working group adopts the draft.
