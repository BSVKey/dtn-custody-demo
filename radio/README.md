# Pay over radio (LoRa / Meshtastic)

A Bitcoin BSV payment signed with no internet, carried over a LoRa radio link to a gateway that
can reach the network, and answered with a receipt signed by the gateway, over the same radio.

```
payer (no internet)                 LoRa radio                gateway (internet)
sign payment offline  ── frames (≤200 B each) ──────────────▶ rebuild, check offline
payee checks it offline ◀── NACK: "resend frame 0" ────────── ask for what is missing
                       ── frame 0 again ────────────────────▶ broadcast (only if told to)
receipt verified       ◀── signed receipt (1 frame) ───────── sign what it did
```

## Run it

```bash
node radio/run-demo.mjs                       # simulated LongFast link, 25% packet loss
node radio/run-demo.mjs --loss=0.4 --beef     # heavier loss, BEEF instead of EF
node radio/run-demo.mjs --preset=ShortFast --realtime
make radio                                    # the same as the first line
node --test test/radio.test.mjs               # 8 tests
```

The demo uses a synthetic funding transaction and broadcasts nothing.

## What crosses the radio

- **Payment.** Extended Format (EF) by default: the raw transaction plus the amount and locking
  script of each output it spends. A one-input payment is about 266 bytes, so 2 frames. With
  that, anyone can check every signature and the amounts with no internet, and ARC accepts it as
  is. `--beef` sends BEEF (BRC-62) instead (344 bytes in the demo). When the sender holds the
  parents' Merkle proofs, BEEF also lets a receiver with block headers check that the coins exist.
- **Frames.** A 13-byte header (type, an 8-byte message id that is a hash of the whole message,
  index, count), then up to 187 bytes of data. That stays under Meshtastic's 233-byte payload
  limit. A reassembled message that does not hash to its id is dropped.
- **NACK.** When a message goes quiet with frames missing, the gateway lists them, and the payer
  resends only those. If nothing comes back at all, the payer resends the whole payment.
- **Receipt.** txid, status, time, message id, the gateway's public key and its signature: about
  150 bytes, one frame. The payer accepts it only if the signature is from the gateway key it
  pinned and the receipt names its txid. Status is `ACCEPTED` (a broadcaster took it),
  `VALID_NOT_SENT` (checked; dry run), `REJECTED` or `BROADCAST_FAILED`.

Time on air for one payment plus its receipt, with no loss (Semtech formula with Meshtastic
framing, approximate):

| Meshtastic preset | Payment (2 frames) | Receipt |
| --- | --- | --- |
| ShortFast (SF7, 250 kHz) | 0.27 s | 0.15 s |
| MediumFast (SF9, 250 kHz) | 0.86 s | 0.49 s |
| LongFast (SF11, 250 kHz), the factory default | 2.92 s | 1.62 s |
| LongSlow (SF12, 125 kHz) | 19.2 s | 10.6 s |

## What an offline check proves, and what it does not

A payee with a radio and no internet can check that the payment is signed correctly, spends
what it says it spends, and pays them the right amount (`paysAddress`). It **cannot** rule out
that the payer spent the same coins somewhere else first. Only a broadcast settles that. So
treat an unbroadcast radio payment like a cheque: fine for small amounts, and wait for the
gateway's `ACCEPTED` receipt for larger ones. If no receipt arrives, the payment may or may not
have reached the gateway. Look up the txid later before paying again.

## Real radios

Two Meshtastic devices (any supported LoRa board, about $30 each) on the same channel, each on
USB, and `pip install meshtastic` on both machines. Frames go on the PRIVATE_APP port (256),
so other Meshtastic traffic on the channel is ignored.

```bash
# gateway (internet): checks and signs receipts, broadcasts nothing
node radio/cli.mjs gateway --port COM4 --key-file gateway.wif
# ...and to broadcast valid payments on BSV mainnet:
node radio/cli.mjs gateway --port COM4 --key-file gateway.wif --spend-real-bsv

# payer, once while still online: save the funding transaction
node radio/cli.mjs fetch-fund <txid> > fund.hex
# payer, offline:
node radio/cli.mjs send --port COM5 --wif-file payer.wif --fund-file fund.hex --to <address> --sats 1000 --gateway-pub <key printed by the gateway>
```

Key files are read, never written or printed. The offline fee rate defaults to 100 sat/kB
(`--fee-rate`), above current miner policy, because the payer cannot fetch the live policy.

**Not yet run on real hardware.** The bridge (`meshtastic/bridge.py`) uses the official
Meshtastic Python library's `sendData` and receive events. The protocol, the offline checks, the
receipts and the resend logic are what the tests and the simulated link exercise.

## Radio rules

- Use licence-free LoRa bands (US 902-928 MHz under FCC Part 15; EU 868 MHz, which has duty-cycle
  limits: at 1% on LongFast, one payment uses about 5 minutes of allowance). Meshtastic sets the
  band from its region setting.
- **Do not use amateur (ham) radio for payments.** FCC Part 97 forbids business or money-making
  traffic on amateur bands. Signatures are not encryption, but a payment is still commercial
  traffic.

## Files

```
lib/frame.mjs      frames, reassembly, LoRa time on air, Meshtastic presets
lib/payment.mjs    EF/BEEF encoding, offline check, signed receipts
lib/gateway.mjs    rebuild, check, broadcast (dry run unless told), receipt, NACK
lib/sender.mjs     send, resend on NACK or silence, verify the receipt
lib/link.mjs       simulated LoRa link: seeded loss, shared channel, time on air
meshtastic.mjs     real radio endpoint (spawns meshtastic/bridge.py)
cli.mjs            gateway / send / fetch-fund on real radios
run-demo.mjs       the simulated end-to-end demo
```
