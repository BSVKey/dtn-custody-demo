# Custody receipts and per-hop payments on Bitcoin BSV mainnet: 4,032 satellites

Submitted 2026-10-18 from AMD Ryzen 5 7600 6-Core Processor, Node v24.14.1, through ARC (https://arc.gorillapool.io) to **Bitcoin BSV mainnet** at 100 sat/kB. Reproduce: `node constellation/ttn-run.mjs --network=mainnet --spend-real-bsv --fund=<txid>`, then `--network=mainnet --confirm`.

## What went on chain

| | |
|---|---|
| Constellation | 4,032 satellites, real orbits (public Starlink elements, SGP4); 10,000 bundles delivered, 10,000 verified off chain |
| Paid, anchored transactions (pay the relaying satellite 100 sat and commit the receipt id) | 30,502 submitted, 0 rejected, 30,502 mined |
| Average transaction size | 251 bytes |
| Per-minute anchors | 11 transactions, 11 mined |
| Blocks | 971658 to 971665; 30,513 merkle proofs checked against block headers, 4 distinct headers rebuilt and their proof of work verified |
| Status counts | MINED 30,513 |

## Timing

| Step | Time | Rate |
|---|---|---|
| Build and sign 30,502 payment transactions (JavaScript, one thread) | 128.9 s | 237 per second |
| Submit to ARC (8 concurrent, 3 busy retries) | 2425.6 s | **13 accepted per second** |

Submission rate here is one client on one desktop against a shared public service, with deliberately limited concurrency; it is not a measure of Teranode's or the broadcaster's capacity.

## Proven from the chain

For 100 sampled bundles (866 hops), each hop's custody receipt verified and the transaction paying that hop and committing that receipt was mined, with a merkle proof matching the block header: **100 of 100 bundles fully custodied and paid**.

## Limits

- Mainnet: real coins and fees. The satellites' payout addresses belong to keys held with the funding key, so their payments can be swept back.
- Payments come from one funding key to per-node payout addresses; the Operator Edition's non-custodial statements are the production settlement path.

## Notes from this run

- Funded with 4,000,000 sats (funding tx `3e6b085603123e7d2ac99483ca7aaba5fa21b2476c40278e71c582472a3bfb37`). A batch of 50 ran first (50 payments and 1 anchor mined, 51 merkle proofs matching headers); this run was funded from its change (`527d5cd4...941700`).
- Cost: 3,050,200 sats paid to the satellites' payout addresses, which belong to keys derived from the funding key and can be swept back (`constellation/sweep.mjs`), and 897,665 sats in miner fees at 100 sat/kB (1,516 more for the batch of 50). 45,619 sats were left as change.
- Inclusion: 25,908 payments were mined within about an hour; the last 4,605 transactions, sent in the final minutes through one broadcaster, waited through a block from another miner that did not include them, and were mined a block later. Sending through several broadcasters (`--broadcast`) and batching payments (`--batch`) are the remedies, now in the script.
- The transactions were signed and sent by the funding key's holder; this repository's tooling only built, checked and confirmed them.
