# Payment runs: ledger

Every run that paid relaying satellites for their custody receipts on a BSV chain, in order, with
where its full record lives. All runs use the same constellation: 4,032 satellites on real orbits
(public Starlink elements, SGP4), 10,000 bundles, 30,502 batch receipts (one per satellite per
contact). Per-run transaction records in `runs/` list every receipt id, the relay it paid, and the
transaction and output that paid it, so anyone can check a payment on chain. They contain no keys.

| Date | Network | Run | Result | Record |
|---|---|---|---|---|
| 2026-09-30 | regtest (private, local Teranode) | 30,502 receipts, 1 tx each, 100 sat | 30,502 confirmed, 11 anchors, 100/100 bundles proven, 61 tx/s | `TERANODE-RESULTS.md` |
| 2026-10-18 | regtest (private, local Teranode) | Rerun of the above | Same: 30,502 confirmed, 100/100 proven, 61 tx/s (blocks 1048 to 1161) | `runs/2026-10-18-regtest-rerun.md` |
| 2026-10-18 | teratestnet (public, via Arcade) | Batch of 50, 1 tx each, 100 sat | First attempt REJECTED: zero-fee fan-out, "insufficient-fee" despite a 0 sat/kB policy. Resent with a fee: 50 + 1 anchor mined (block 36961), 51 proofs match headers | `TTN-RESULTS.md` notes |
| 2026-10-18 | teratestnet | Full run, 1 tx each, 1 sat | 30,502 + 11 anchors mined (blocks 36963 to 36964), 30,513 proofs match headers, 100/100 proven, 82 tx/s | `TTN-RESULTS.md`, `runs/2026-10-18-teratestnet-full.json` |
| 2026-10-18 | teratestnet | Batch mode: 100 payments per tx, chained batches, 1 sat, 15,000 receipts | 155 tx sent in 19.8 s (757 payments/s); some nodes saw children before parents (TX_MISSING_PARENT), tail rebroadcast by Arcade; all 155 mined, 155 proofs match, 8 headers' proof of work verified, 100/100 proven | `runs/2026-10-18-teratestnet-batch100.json` |
| 2026-10-18 | teratestnet | Sweep test: 1,000 payout outputs | 2 sweep tx accepted (extended format built from known inputs) | `runs/2026-10-18-teratestnet-sweep.json` |
| 2026-10-18 | **Bitcoin BSV mainnet** (via GorillaPool ARC) | Batch of 50, 1 tx each, 100 sat | 50 + 1 anchor mined, 51 proofs match headers | `runs/2026-10-18-mainnet-batch50.json` |
| 2026-10-18 | **Bitcoin BSV mainnet** | Full run, 1 tx each, 100 sat, 100 sat/kB | 30,502 + 11 anchors mined (blocks 971658 to 971665), 30,513 proofs match headers with proof of work verified, 100/100 proven. 13 tx/s; last 4,605 waited one block. Fees 897,665 sat | `MAIN-RESULTS.md`, `runs/2026-10-18-mainnet-full.json` |
| 2026-10-18 | **Bitcoin BSV mainnet** | Sweep of the full run's 30,502 payouts | 62 sweep tx sent, 0 rejected, all mined: 3,050,200 sat collected, 451,739 fees, 2,598,461 back to the funding address | `runs/2026-10-18-mainnet-sweep.json` |
| 2026-10-18 | **Bitcoin BSV mainnet** | Test: batch mode with one fan-out parent, 100 payments per tx, 300 receipts, sent through three broadcasters | 5 tx sent in 6.8 s, accepted by GorillaPool ARC, BSVA's mainnet Arcade and WhatsOnChain (5 of 5 each); 300 payments and the anchor mined in the next block, 4 proofs match a header with proof of work verified. Payments to fresh per-payment addresses | `runs/2026-10-18-mainnet-multibroadcast-batch100.json` |

## Checks without new payments

- **Rebroadcast rebuild** (mainnet): rebuilding the full run from its funding output reproduced all
  30,544 transaction ids exactly, so `--rebroadcast` can resend a stuck run with no new payments.
- **Sweep key check** (mainnet): payout outputs sampled from the chain match the keys derived from
  the funding key, for both the batch of 50 and the full run.
- **SPV header check**: real teratestnet and mainnet headers pass; a header with a changed nonce or
  merkle root fails.

## Not yet run live

- `--rebroadcast` sending: the rebuild is verified against all 30,544 mainnet txids, but no run
  has needed resending since it was built.
- Batch mode at full scale (30,502 receipts in 306 transactions) on mainnet.

## Who sent what

Teratestnet and regtest coins have no value; those runs were sent by this repository's tooling.
Mainnet transactions were signed and sent by the holder of the funding key; the tooling built,
checked and confirmed them.
