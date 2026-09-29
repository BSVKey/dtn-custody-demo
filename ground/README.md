# Ground-side pilot kit

Custody records produced entirely at a ground station, from data it has already
received. Nothing changes on the spacecraft, the radio or the DTN software, and nothing
leaves the station unless the operator chooses to publish the ledger's 32-byte seal.

```
node ground/demo.mjs          # two simulated stations, one missed pass, a tampered file
```

## What it produces

For every received product (a file your ground software wrote), the station signs:

- a `manifest/1` over the file's chunks (Merkle root, whole-file SHA-256, size, name,
  and the scheduled pass it arrived in), and
- a `custody/1` receipt with `prevHop` = the spacecraft and `thisHop` = the station.

For every scheduled pass, the station signs a `station.pass/1` report: how many
products arrived, first and last reception time, and a status. A pass with no data is
recorded as `no-data` and carries a `gap/1` that starts at the scheduled pass start and
ends when data next arrived at that station. Silence becomes a dated record, not an
absence.

Products that arrived outside any scheduled pass are listed in a
`station.unscheduled/1` record.

The ledger is sealed with a signed `station.ledger/1`: a Merkle root over every record id.
Dropping, adding or re-signing any record changes the root.

| Record | Signed by | Key fields |
|---|---|---|
| `manifest/1` | station | `payloadId`, `chunkCount`, `root`, `meta.{observedBy, name, bytes, sha256, chunkSize, passId}` |
| `custody/1` | station | `bundleId` (= the manifest's `claimId`), `prevHop` (spacecraft), `thisHop` (station), `receivedAt` |
| `station.pass/1` | station | `passId`, `scheduledStart`, `scheduledEnd`, `products`, `firstAt`, `lastAt`, `payloadIds[]`, `status`, `gap` (when `no-data`) |
| `station.unscheduled/1` | station | `products[]` of `{name, receivedAt, payloadId}` |
| `station.ledger/1` | station | `recordCount`, `root` (Merkle root over record `claimId`s, in ledger order) |

All records use the primitives in [`../spec/CUSTODY-RECORDS.md`](../spec/CUSTODY-RECORDS.md):
canonical JSON, `claimId` = SHA-256 content id, Ed25519 signature, domain-separated
Merkle tree.

## Running it at a station

1. Point the sidecar at the directory where your ground software writes received
   products (HDTN `BpReceiveFile`, ION `bpcp`, or any file drop), and at your pass
   schedule:

   ```
   node ground/station.mjs --in /data/recv --passes passes.json \
        --station ipn:20.0 --spacecraft ipn:5.0 --key station-key.json --out ledger.json
   ```

   `passes.json` is `{ "passes": [{ "passId", "start", "end" }] }` with ISO times or
   epoch milliseconds. Reception time is the file's modification time; if your software
   logs the true reception time, add `"received": { "<file name>": <time> }`.

2. The first run creates `station-key.json`. Keep it private and give its `pub` value to
   anyone who will verify (customers, auditors, partner stations).

3. Verify, re-hash the products, and compare with a second station:

   ```
   node ground/verify.mjs ledger.json --pub <station pub> --files /data/recv \
        --with other-ledger.json --pub2 <other station pub>
   ```

   Verification uses only the pinned key the verifier supplies, never the key carried
   in the ledger. Products received identically by both stations are reported as
   corroborated.

## What this does and does not prove

It proves what this station received, when, and that neither the products nor the
records have changed since; it documents every scheduled pass, including silent ones;
and two stations can corroborate each other. It does not prove what the spacecraft
sent. That needs a manifest signed at the source (see `agent/`) or on board
(`flight/`), after which the station's receipt becomes one hop in a full custody chain.

Keys here are file-based for the pilot. Production key custody (rotation, revocation,
hardware-backed signing) is a separate component.
