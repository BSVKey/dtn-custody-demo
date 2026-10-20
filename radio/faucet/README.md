# Faucet: give Bitcoin BSV over sound, radio, text or QR

You choose the coin size and how many coins there are (or a total to split). One funding
transaction, the fan-out, makes the coins. You announce them on any link this repo speaks: a
phone speaker, a walkie-talkie, an AM or FM station's audio, a phone call, LoRa, SMS, or a printed
QR code. The phone page (`radio/handoff/index.html`) hears or scans the announcements.

## Two modes

**Claims (two-way, the fair one).** The faucet keeps the coin keys. People send
`BSV1 CLAIM <address>` by text. The faucet pays one coin per claimant and replies with a receipt
signed by the faucet key. Limits:

- one coin per sender (phone number) and per address, by default;
- robots sign their claim with a device key (`claimText(address, { id, deviceKey })`), and the
  limit then follows the key. Device keys are free to make, so this keeps honest robots from
  double-claiming, but it does not stop a determined cheat. Phone numbers are harder to come by.

Claims are handled one at a time and written to `claims.jsonl` before the reply. A restart never
pays a coin or a claimant twice. A payout whose broadcast fails still uses up its coin, since it
may have gone through, but it does not use up the claimant's turn.

**Bearer (one-way).** The coin keys themselves are broadcast, one 131-character line per coin. A
listener's phone signs the coin over to their own address offline, and they forward that payment
whenever they reach a gateway. Each coin can be claimed once: the first sweep the network accepts
wins it, and later ones are refused. With no reply channel there is no fair share, only first come,
first served. Anyone near the internet with a script can race for every coin, so use small coins
and expect that.

## Sizes, and what gets refused

- A coin must be worth more than the fee to claim it, or the claim would be refused. At 100 sat/kB
  a claim costs about 20 sat, so coins must be at least 50 sat (`planFaucet` enforces it).
  Claimants receive the coin minus that fee.
- The funding must cover every coin plus the fan-out's own fee (500 coins of 1,000 sat need
  501,727 sat). `build` refuses anything less.
- At most 1,296 coins per faucet: run another one for more.
- Each faucet's coin keys come from its key and its funding output, so one key can run many
  faucets, and a bearer faucet's broadcast keys never unlock another faucet's coins.

## Run one

```bash
node radio/faucet/cli.mjs plan --coin 1000 --count 500
node radio/faucet/cli.mjs build --key-file faucet.wif --fund-file fund.hex --coin 1000 --count 500 --dir my-faucet --claim-to +15551234567
node radio/faucet/cli.mjs broadcast --dir my-faucet --spend-real-bsv       # you run this: it spends real BSV
node radio/faucet/cli.mjs announce --dir my-faucet --wav announce.wav --channel walkie
node radio/faucet/cli.mjs serve --dir my-faucet --key-file faucet.wif --android-key-file signing.key --android-device http://<phone ip>:8080 --android-user <user> --android-pass-file android.pass
node radio/faucet/cli.mjs status --dir my-faucet
```

For bearer mode, add `--mode bearer` to `build` and `--key-file` to `announce`. A listener without
the phone page can sweep from a terminal:
`node radio/faucet/cli.mjs sweep --line "<coin line>" --to <address>`.

`fund.hex` is a transaction paying the faucet key's address, saved with
`node radio/cli.mjs fetch-fund <txid> > fund.hex`. `serve` is a dry run unless `--spend-real-bsv`.
It also relays ordinary payments on the same number, including swept bearer coins.

## What has been checked

In tests (`test/radio-faucet.test.mjs`, and a walkie-talkie case in `test/radio-channels.test.mjs`):
planning and refusals, the fan-out, bearer lines and offline sweeps, every claims limit, restarts
and concurrent claims, failed broadcasts, sharing a number with the payment gateway, the amateur
profile refusing faucet traffic, and announcements plus coin lines surviving a simulated
walkie-talkie. In the browser: the page turns a heard announcement into a "Claim by text" link and
sweeps a bearer coin into its outbox.

**Run on mainnet (2026-10-20), bearer mode:** 5 coins of 1,000 sat made by a fan-out broadcast
from an iPhone (block 971845), announced as sound from a computer speaker, heard by the phone
page, and two coins swept and broadcast from the phone (980 sat each). Details and transaction
links in `radio/RESULTS.md`.

**Not yet done:** claims mode with real money (texted claims and limits), and announcements over
real radios.
