# Custody records: specification, version 1

Status: draft 1, 2026-09-29. Covers the record formats produced by three open-source
reference implementations (Apache-2.0, Embryo Space Inc. DBA BSVKey):

- [dtn-custody-demo](https://github.com/BSVKey/dtn-custody-demo): data custody over
  delay/disruption-tolerant networks (`manifest/1`, `custody/1`, `gap/1`, `delivery/1`)
- [open-downlink-custody](https://github.com/BSVKey/open-downlink-custody): satellite
  downlink receipts over SatNOGS (`odc.*`)
- [wx-custody](https://github.com/BSVKey/wx-custody): NOAA data verified across cloud
  mirrors (`wx.*`)

The goal is that anyone can produce or verify these records without reading or forking the
code. Normative test values are in [`test-vectors.json`](test-vectors.json); the test suite
regenerates them from the implementation on every run, so this document and the code
cannot drift apart. The key words MUST, SHOULD and MAY are used as in RFC 2119.

## 1. Primitives

### 1.1 Canonical JSON

A record's canonical form is its JSON serialization with the keys of every object sorted
recursively in code-unit order (JavaScript default string sort), no whitespace, and
standard JSON escaping. Arrays keep their order. Nesting deeper than 32 levels MUST be
rejected.

Example (vector `canonical`): `{"b":2,"a":{"d":[3,{"f":1,"e":0}],"c":"x"}}` canonicalizes
to `{"a":{"c":"x","d":[3,{"e":0,"f":1}]},"b":2}`.

### 1.2 Content identifier

`contentId(record) = "0x" + lowercase_hex(SHA-256(UTF-8(canonical(content))))`, where
`content` is the record without its credential fields `claimId`, `sig` and `signerPub`.
Adding or changing credential fields MUST NOT change the content identifier (vector
`canonical.contentIdIgnoresCredentials`).

### 1.3 Signed record

A signed record is its content plus three credential fields:

| Field | Value |
|---|---|
| `claimId` | `contentId(content)` |
| `sig` | signature over the UTF-8 bytes of the `claimId` string, base64 |
| `signerPub` | the signer's public key, base64 |

Version 1 signatures are Ed25519 (RFC 8032) with the public key as base64 DER
SubjectPublicKeyInfo. A production profile MAY use a signature envelope from which the
signer is recovered instead of carried; the content identifier is unchanged.

Verification, in order:

1. Recompute `contentId`; it MUST equal `claimId`, else `content_mismatch` (some
   implementations report `claimId_mismatch`).
2. The signature MUST verify under `signerPub`, else `signature_invalid`.
3. The verifier MUST compare `signerPub` against a key it obtained independently (a
   pinned key). A record that verifies under an unexpected key MUST be refused
   (`signer_not_pinned` or a more specific reason). Keys are compared exactly (base64 is
   case-sensitive).

### 1.4 Merkle tree

- Leaf: `SHA-256(0x00 || data)`.
- Internal node: `SHA-256(0x01 || left || right)` over the raw 32-byte child hashes.
- An odd node at any level is paired with itself (the last node is duplicated).
- Hashes are written as lowercase hex without a prefix.
- A proof for leaf `i` is the list of sibling hashes from the leaf level up. The fold
  direction is NOT carried; it is derived from the claimed index (bit `k` of `i` set means
  the running hash is the right child at level `k`). A valid leaf presented at a different
  index MUST fail (vector `merkle.proofIndex2.verifiesAtWrongIndex`).

## 2. DTN custody records (dtn-custody-demo)

| Kind | Fields (content) | Signed by |
|---|---|---|
| `manifest/1` | `payloadId`, `chunkCount`, `root` (Merkle root of the chunks), `meta` (includes `chunkSize`) | payload source |
| `custody/1` | `payloadId`, `bundleId`, `prevHop`, `thisHop`, `receivedAt`, `forwardedAt` | the node at `thisHop` |
| `delivery/1` | `payloadId`, `root`, `rail`, `network`, `settlementRef`, `payTo`, `amountAtomic` | the destination |
| `gap/1` (unsigned object, carried inside signed records) | `link`, `downAt`, `upAt`, `durationMs`, `bundlesDelayed[]`, `bundlesLostConfirmed[]`, `note` | none |

Rules:

- **Chunks.** The payload is split into fixed-size chunks (`meta.chunkSize`); chunk `i`
  is Merkle leaf `i`. A bundle carries `payloadId`, `index`, `leafHex`, the chunk bytes
  and its branch; `bundleId = contentId({payloadId, index, leafHex})`.
- **Chunk acceptance.** A receiver MUST check `leafHash(bytes) == leafHex` and the branch
  against the pinned manifest's `root` at the claimed `index` before storing a chunk.
- **Custody chain.** For one bundle, receipts are ordered by the verifier's pinned hop list
  `[{eid, pub}]`. Each receipt MUST verify, carry that `bundleId`, have `thisHop` equal
  to the pinned hop, be signed by that hop's pinned key, and (after the first) have
  `prevHop` equal to the previous receipt's `thisHop`. Failure reasons:
  `wrong_hop_count`, `wrong_bundle`, `unexpected_hop`, `signer_not_pinned_hop_key`,
  `custody_chain_break`.
- **Gap.** A link outage MUST be recorded as a gap object with its boundaries and the
  bundles it delayed; silence is never read as "nothing happened".
- **Delivery binding.** A verifier binds a delivery receipt to the payment it made itself.
  The expected `settlementRef` MUST come from the verifier's own records, never from the
  receipt; an unbound check MUST refuse (`unbound`), not pass. `settlementRef` compares
  case-insensitively (hex); `payTo` compares exactly.

## 3. Satellite downlink records (open-downlink-custody)

All carry `source` = `{network, attribution, license, licenseUrl, notice}` crediting the
data provider. Records MUST NOT contain station coordinates, hostnames or frame contents.

| Type | Scope | Key fields |
|---|---|---|
| `odc.station-receipt/1` | one observation | `observationId`, `norad`, `transmitter`, `mode`, `window{start,end}`, `station{id,name,owner}`, `frameCount`, `frames[{i,t,len,leaf,src}]`, `framesRoot`, `witnessedAt`, `attests` |
| `odc.pass-manifest/1` | one pass (overlapping observations of one satellite) | `norad`, `window`, `stationCount`, `independentOwners`, `uniqueFrames`, `corroboratedFrames`, `stations[{observationId,stationId,owner,receiptId,frameCount,uniqueFrames,missedFrames,gaps[]}]`, `frames[{leaf,firstSeen,seenBy[],independentOwners}]`, `framesRoot` |
| `odc.custody-batch/1` | one run | `passes[{index,manifestId,norad,window}]`, `root` (Merkle root over manifest ids) |
| `odc.station-signed/1` | one observation, signed by the station itself before upload | `observationId`, `signedAt`, `frameCount`, `frames[{i,file,t,len,leaf}]`, `framesRoot` |

Corroborated means byte-identical frames archived by stations with at least two different
owners. `missedFrames` counts frames another station archived inside this station's own
window (with 5 s slack) that this station did not archive: a reception record, not a
failure. Batch leaves are `leafHash(32 raw bytes decoded from the manifest claimId hex, without "0x")`.

## 4. Mirror-corroborated data records (wx-custody)

All carry `source` = `{program, license, notice}`.

| Type | Key fields |
|---|---|
| `wx.file-receipt/1` | `key`, `product`, `satellite`, `scanStart`, `scanEnd`, `created`, `observations[{mirror,operator,url,present,size,sha256,md5Claimed,md5Actual,lastModified,publishLagSec}]`, `verdict`, `witnessedAt` |
| `wx.window-manifest/1` | `product`, `satellite`, `window`, `files`, `summary`, `cadenceSec`, `gaps[]`, `perMirror[]`, `discrepancies[]`, `receipts[{index,key,scanStart,receiptId,status}]`, `root` |

The witness MUST hash the bytes it downloaded itself; checksums published by a mirror are
recorded as claims and checked, never trusted. `verdict.status` is one of
`corroborated_all`, `corroborated_partial`, `single_source`, `DISCREPANCY` or
`missing_everywhere`, and a verifier MUST recompute it from `observations`.

## 5. Anchoring (optional)

A batch or window root MAY be committed to a public append-only ledger so that anyone can
confirm the records existed unchanged by a given time. Version 1 anchors on BSV in one
output with script `OP_FALSE OP_RETURN <32-byte root>` (hex `006a20` + root). Only the root
is published, never record contents or personal data. Anchoring can happen later than
signing without weakening the records, because times are inside the signed content.

## 6. Versioning

The type or kind string carries the version (`/1`). A change to any field's meaning or to
a primitive in Section 1 requires a new version; adding an optional field does not.
Verifiers MUST refuse types they do not implement rather than guess.

## 7. Security considerations

- Pin keys out of band; a record that merely verifies proves nothing about who signed it.
- Network-side witnesses (Sections 3 and 4) attest what a public source served at
  `witnessedAt`, not ground truth; independence is only as good as the sources.
- Times are claims by the signer. Monotonic sequence numbers and later reconciliation
  against an external clock are RECOMMENDED where timing matters.
- Test keys in `test-vectors.json` are public and MUST NOT be used outside tests.
