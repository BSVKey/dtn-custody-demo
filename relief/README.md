# relief/: field data after a disaster, with proof

When an earthquake or flood takes the cell network down, the information relief
coordinators need most (how many patients each clinic saw, who needs transfer, what
supplies are running out, whether a cholera cluster is starting) is stuck where it was
written. It still moves, by motorbike, by boat, through one satellite terminal running on a
solar panel, but nobody can say afterwards what arrived, whether it was changed on the way,
who carried it, or who should be paid for carrying it.

This walk-through runs that case with the custody agent:

```
field clinic (tablet) -> motorbike courier (phone) -> village relay (satellite terminal) -> district hub
        Wi-Fi Direct           40 minute ride               GEO uplink, out of power 70 min
```

```bash
node relief/run.mjs          # readable walk-through
node relief/run.mjs --json   # the hub's evidence (reports, gap records, payouts, refusals)
```

## What it shows

| Check | How |
|---|---|
| Reports stay confidential | Each clinic encrypts its report to the hub (X25519, HKDF-SHA256, AES-256-GCM). The courier and the village relay carry and sign ciphertext only. |
| Nothing is altered on the way | Every chunk is checked against the clinic's signed Merkle root, in whatever order it arrives. A byte changed on the courier's phone is rejected (`leaf_hash_mismatch`). |
| Every handoff is accounted for | The courier and relay each sign a custody receipt per bundle; the hub checks the chain against keys it already holds. |
| Outages are recorded, not silent | The 70-minute power cut becomes a gap record: which link, how long, which bundles waited, none lost. |
| Carriers are paid for proven work only | Each relay operator is paid per bundle whose custody chain verified (50 sats each here). An impostor claiming to be the courier is refused (`signer_not_pinned_hop_key`). |

## What is real and what is modeled

- **Real:** the cryptography (encryption, signatures, Merkle proofs, custody chain checks)
  is the same code that runs over µD3TN, NASA HDTN, JPL ION and Aalyria Hardy elsewhere in
  this repo, and that settled 30,502 relay payments on BSV mainnet
  (`constellation/MAIN-RESULTS.md`).
- **Modeled:** the network. Links, the ride and the power cut come from
  [`scenario.json`](scenario.json) through the offline simulator; nothing waits. The
  reports are synthetic. The payouts are computed, not broadcast; `live/` and
  `constellation/` show the real BSV payment path.
- **Not covered here:** provisioning keys onto devices before deployment, losing or
  replacing a device, and the data-protection rules for health data where it is used.
  Those are the first things a field pilot needs to settle.

## Taking it to the field

A pilot needs no new hardware: a BPv7 node such as µD3TN on the clinic tablets, the
couriers' Android phones and a small computer at the satellite terminal, with this agent
beside it (`npm install @bsvkey/dtn-custody`, see [`docs/QUICKSTART.md`](../docs/QUICKSTART.md)).
The scenario file is a standard contact plan, so the same schedule compiles for HDTN, ION and
Hardy: `node contact-plans/compile.mjs relief/scenario.json`. To discuss a pilot, open an issue.
