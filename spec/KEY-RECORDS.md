# Key records: offline key management for custody receipts

Version 1, 2026-10-21. Implementation: `transport/bpv7/keyring.mjs`, verification in
`transport/bpv7/receipt-v2.mjs`. Tests: `test/bpv7-keyring.test.mjs`. Live runs:
`transport/bpv7/RESULTS.md` section 9.

## The problem

BPSec (RFC 9172, 9173) says how to sign and encrypt bundles and leaves key management out of
scope. Custody receipts have the same gap: a verifier has to know which key may sign for which
node. On a network where a node may be a light-day away, out of contact for days, and never
able to reach an online certificate authority or revocation list, the usual answers do not
work. This specification answers it with signed records that travel inside bundles and that
a verifier checks with nothing but its operators' root keys and its own clock.

## Records

Two record types, each a COSE_Sign1 (RFC 9052, EdDSA over Ed25519, alg -8) whose payload is
a CBOR map with integer keys. A key id is the first 16 bytes of SHA-256 of the raw 32-byte
public key.

| Key | Key record (kind 1) | Revocation (kind 2) |
|---|---|---|
| 1 | kind = 1 | kind = 2 |
| 2 | subject EID | |
| 3 | public key (bstr, 32 bytes) | |
| 4 | roles: 1 custody, 2 issue, 4 revoke (bits) | |
| 5, 6 | notBefore, notAfter (DTN time, ms) | |
| 7 | issuedAt | issuedAt |
| 8 | issuer key id | signer key id |
| 9 | replaces: key id this one rotates out (optional) | |
| 10 | | revoked key id |
| 11 | | effectiveFrom: earliest moment the key may have been out of its holder's control |
| 12 | | reason (text) |

Trust starts at **anchors**: root public keys the verifier holds out of band, one per
operator. Anchors never travel and are not revoked by records (replacing an anchor is an
out-of-band act).

## Carriage: the Key Record Block

Block type **225**, block-type-specific data = a CBOR array of records, flag "replicate in
every fragment", at most 32 records. Any node may add records; custodians merge what they
know (revocations first) as they stamp, so key material and revocations spread along with
ordinary traffic rather than waiting for a control channel. A verifier ingests the records
of every bundle it receives, recording the time it first saw each one by its own clock.

## Rules (all applied offline)

1. **Key chain.** A key record counts if its issuer is an anchor, or a key whose own record
   counts, holds the issue role, and was within its validity window at the record's
   issuedAt; and the signature verifies. Chains are at most 6 deep.
2. **Use.** A receipt signed by a key counts only for the key record's subject EID, with the
   custody role, at a signing time (the receipt's forwardedAt) inside the validity window.
3. **Revocation authority.** A revocation counts if it is signed by the revoked key itself
   (self-revocation: a node that detects tampering can retire its key without its
   operator), by any key in the revoked key's issuing chain, by any anchor, or by a key with
   the revoke role that chains to the same anchor. Revocations are permanent; when several
   apply, the earliest effectiveFrom wins.
4. **Issuer compromise.** If an issuer is revoked from T, the key records it signed count only
   if the verifier first saw them before T. A stolen issuer key can write any issuedAt, so
   only the verifier's own clock decides.
5. **Witnessed time.** A receipt signed with a key revoked from T must claim a signing time
   before T **and** be witnessed before T, by either
   - a later receipt in the same block whose field 9 (below) commits to it, signed with an
     unrevoked key, with receivedAt before T; or
   - the verifier's own arrival time, if before T.

   A thief holding a stolen key can write any time into a receipt, but cannot make an honest
   custodian (or the verifier) have seen that receipt in the past.

## Receipt v2 additions

Two optional fields in the receipt map (`receipt-v2.mjs`); receipts without them are
unchanged and still valid.

- **8 hopCount**: `[hop count as received, hop count as released]`, from the RFC 9171 Hop
  Count block. Between two custodians, `next.received - prev.released` plain forwarders
  handled the bundle unsigned. All four stacks tested count hops this way
  (`transport/bpv7/RESULTS.md` section 8). This also exposes forwarders where the chain
  *names* the previous custodian but the bundle passed through others (uD3TN adds no
  Previous Node block, so without field 8 that path looked fully custodied).
- **9 chain**: SHA-256 of the CBOR array of the receipts already in the block when this one
  was signed. A receipt can no longer be inserted, removed or reordered ahead of it without
  detection, and it is what lets a later custodian act as a time witness (rule 5).

## What this does not do

- Anchor replacement and k-of-n control of anchors are out of band.
- Rule 4 depends on the verifier's clock, and rule 5 on the honesty of at least one later
  custodian or the verifier's arrival; a verifier that first sees a legitimate record after
  its issuer was compromised rejects it (re-issue under an unrevoked issuer).
- A revocation's reach is the reach of traffic: a node that receives no bundles learns
  nothing. Revocations are prioritised in block 225 but the block is capped at 32 records.
- No confidentiality: records are public by design.
