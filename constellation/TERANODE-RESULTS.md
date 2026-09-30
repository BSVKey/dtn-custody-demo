# Custody receipts and per-hop payments through Teranode: 4,032 satellites

Run 2026-09-30 on AMD Ryzen 5 7600 6-Core Processor, Node v24.14.1. Teranode (BSV) on a **private local regtest chain**: coins were mined for the test and have no value; nothing was sent to any public network. Reproduce against a Teranode regtest node: `RPC_USER=... RPC_PASS=... node constellation/teranode-run.mjs`.

## What went on chain

| | |
|---|---|
| Constellation | 4,032 satellites, real orbits (public Starlink elements, SGP4); 10,000 bundles delivered, 10,000 verified off chain |
| Batch receipts (one per satellite per contact) | 30,502 |
| Paid, anchored transactions (one per batch receipt: pays the relaying satellite 100 sat and commits the receipt id) | 30,502 submitted, 0 rejected, 30,502 confirmed |
| Average transaction size | 251 bytes |
| Per-minute anchors (one Merkle root over each minute's receipts) | 11 transactions covering 30,502 receipts, 11 confirmed |
| Blocks | 825 to 938; inclusion read from each block's subtree transaction lists |

## Timing

| Step | Time | Rate |
|---|---|---|
| Mine and split funds (110 blocks, 31 fan-out transactions) | 6.2 s | |
| Build and sign 30,502 payment transactions (JavaScript, one thread) | 131.2 s | 233 per second |
| Submit to Teranode over JSON-RPC (16 concurrent, 2,777 busy retries, 125 resubmitted in slower passes) | 503.7 s | **61 accepted per second** |
| Mine until all confirmed (2 blocks) | 3.6 s | |

Throughput here is bounded by one JSON-RPC client on one desktop running every Teranode service in Docker, not by Teranode's design capacity; treat it as a floor for this setup.

## Proven from the chain

For 100 sampled bundles (866 hops), each hop's custody receipt verified and the chain held a confirmed transaction paying that hop's own payout address and committing that exact receipt: **100 of 100 bundles fully custodied and paid**.

## What it costs

At the mainnet relay floor of 100 sat/kB (see docs of the quickstart), one paid, anchored receipt of about 251 bytes costs about 25 satoshi in fees, and a per-minute anchor about 25 satoshi. Anchoring only the per-minute roots, a whole constellation's custody costs 11 small transactions per 11 minutes.

## Notes from getting this to run

- The node's asset service had stopped at startup (its database was not yet ready) and had
  to be started; this Teranode build's RPC answers transaction lookups through it.
- This build's RPC has no `gettxout` or `gettxoutproof`, and `getblock` does not list
  transaction ids, so inclusion is read from the asset API: block, then its subtrees, then
  each subtree's transaction list (paginated, at most 100 per page).
- More than about 4,000 standard payment outputs in one transaction exceeds the node's
  signature-operation policy; funds are split 1,000 outputs at a time.
- The single JSON-RPC service answers HTTP 503 when busy. Sixteen concurrent submitters
  with backoff, plus a slower resubmission pass, got every transaction in. For production
  volume, transactions go through ARC, the BSV broadcast service, not one node's RPC.

## Limits

- Regtest on one machine: no network propagation, no competing load, no real fees. Teratestnet (the BSV Association's shared Teranode test network) and mainnet will differ.
- Payments are simulated micropayments from one funding key to per-node payout addresses; the Operator Edition's non-custodial statements are the production settlement path.
