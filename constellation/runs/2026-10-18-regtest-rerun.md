# Custody receipts and per-hop payments through Teranode: 4,032 satellites

Run 2026-10-18 on AMD Ryzen 5 7600 6-Core Processor, Node v24.14.1. Teranode (BSV) on a **private local regtest chain**: coins were mined for the test and have no value; nothing was sent to any public network. Reproduce against a Teranode regtest node: `RPC_USER=... RPC_PASS=... node constellation/teranode-run.mjs`.

## What went on chain

| | |
|---|---|
| Constellation | 4,032 satellites, real orbits (public Starlink elements, SGP4); 10,000 bundles delivered, 10,000 verified off chain |
| Batch receipts (one per satellite per contact) | 30,502 |
| Paid, anchored transactions (one per batch receipt: pays the relaying satellite 100 sat and commits the receipt id) | 30,502 submitted, 0 rejected, 30,502 confirmed |
| Average transaction size | 251 bytes |
| Per-minute anchors (one Merkle root over each minute's receipts) | 11 transactions covering 30,502 receipts, 11 confirmed |
| Blocks | 1048 to 1161; inclusion read from each block's subtree transaction lists |

## Timing

| Step | Time | Rate |
|---|---|---|
| Mine and split funds (110 blocks, 31 fan-out transactions) | 6.3 s | |
| Build and sign 30,502 payment transactions (JavaScript, one thread) | 131.4 s | 232 per second |
| Submit to Teranode over JSON-RPC (16 concurrent, 2,747 busy retries, 125 resubmitted in slower passes) | 503.6 s | **61 accepted per second** |
| Mine until all confirmed (2 blocks) | 3.6 s | |

Throughput here is bounded by one JSON-RPC client on one desktop running every Teranode service in Docker, not by Teranode's design capacity; treat it as a floor for this setup.

## Proven from the chain

For 100 sampled bundles (866 hops), each hop's custody receipt verified and the chain held a confirmed transaction paying that hop's own payout address and committing that exact receipt: **100 of 100 bundles fully custodied and paid**.

## What it costs

At the mainnet relay floor of 100 sat/kB (see docs of the quickstart), one paid, anchored receipt of about 251 bytes costs about 25 satoshi in fees, and a per-minute anchor about 25 satoshi. Anchoring only the per-minute roots, a whole constellation's custody costs 11 small transactions per 11 minutes.

## Limits

- Regtest on one machine: no network propagation, no competing load, no real fees. Mainnet and teratestnet behaviour will differ.
- Payments are simulated micropayments from one funding key to per-node payout addresses; the Operator Edition's non-custodial statements are the production settlement path.

TERANODE_RESULT {"ok":true,"batches":30502,"confirmed":30502,"perSecond":60.6,"proven":100}
