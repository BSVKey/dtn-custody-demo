# Custody receipts and per-hop payments on teratestnet: 4,032 satellites

Submitted 2026-10-18 from AMD Ryzen 5 7600 6-Core Processor, Node v24.14.1, through Arcade (https://arcade-ttn-us-1.bsvblockchain.tech) to **teratestnet**, BSV's public Teranode test network. Teratestnet coins have no value. Reproduce: `node constellation/ttn-run.mjs --fund=<txid>`, then `--confirm`.

## What went on chain

| | |
|---|---|
| Constellation | 4,032 satellites, real orbits (public Starlink elements, SGP4); 10,000 bundles delivered, 10,000 verified off chain |
| Paid, anchored transactions (pay the relaying satellite 1 sat and commit the receipt id) | 30,502 submitted, 0 rejected, 30,502 mined |
| Average transaction size | 251 bytes |
| Per-minute anchors | 11 transactions, 11 mined |
| Blocks | 36963 to 36964; 30,513 merkle proofs from Arcade checked against block headers |
| Status counts | MINED 30,513 |

## Timing

| Step | Time | Rate |
|---|---|---|
| Build and sign 30,502 payment transactions (JavaScript, one thread) | 127.9 s | 239 per second |
| Submit to Arcade (8 concurrent, 0 busy retries) | 370.9 s | **82 accepted per second** |

Submission rate here is one client on one desktop against a shared public service, with deliberately limited concurrency; it is not a measure of Teranode's or Arcade's capacity.

## Proven from the chain

For 100 sampled bundles (866 hops), each hop's custody receipt verified and the transaction paying that hop and committing that receipt was mined, with a merkle proof matching the block header: **100 of 100 bundles fully custodied and paid**.

## Limits

- Teratestnet is a public test network: real propagation and competing load, but no-value coins and test-network fee policy.
- Payments come from one funding key to per-node payout addresses; the Operator Edition's non-custodial statements are the production settlement path.

## Notes from this run

- Funded from BSVA's teratestnet faucet (https://faucet-ttn.bsvblockchain.tech/, 100,000 sats per claim), funding tx `9d2588e56d9bd85a3231409dd53ceba2fecf680376b43a46277cd67e0f2d34dc`. To fit 30,502 payments in one claim, each relaying satellite is paid 1 sat here (100 sat in the regtest run, `TERANODE-RESULTS.md`); the binding of payment to receipt is the same.
- A batch of 50 ran first (50 payments and 1 anchor mined in block 36961, 51 merkle proofs matching headers); this full run was funded from its change.
- Arcade's `/v1/policy` reports a mining fee of 0 sat/kB, but a zero-fee fan-out was accepted on submission and then `REJECTED` with `TX_POLICY (39): insufficient-fee` (tx `fbf007bf...e02f`), taking its children with it. The fan-outs now pay 5 sat/kB; payments and anchors already paid about 4 sat/kB.
- The asset API returns transactions in extended format, and its header-by-height route now requires authentication; the script reads EF and fetches headers by block hash.
