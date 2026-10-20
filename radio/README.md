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

Any `--port <serial>` can be `--host <ip[:port]>` instead: a Meshtastic node on the network
(a radio on Wi-Fi, or `meshtasticd`, Meshtastic's Linux build), over TCP port 4403.

### Without radios: real firmware in Docker

```bash
python -m pip install meshtastic
bash radio/meshtasticd/run-sim.sh
```

This starts two `meshtasticd` nodes with simulated radios, linked by Meshtastic's UDP LAN mesh,
and runs a payer and a gateway against them (dry run). It passed on 2026-10-19 with firmware
2.7.26: payment out, signed receipt back in about 1 second (`RESULTS.md`). That exercises the
bridge, the Meshtastic library and the firmware's PRIVATE_APP port. It does **not** exercise
LoRa airtime, range or loss, because the packets cross by UDP. **Not yet run on two physical
radios.**

## Phone to phone: QR code, sound, or a text

`radio/handoff/index.html` is one self-contained page (about 650 KB, everything inline, no
network requests except the "Broadcast now" button). Open it once, save it, and it works on a
phone with no internet.

- **Pay:** load a signed payment (paste EF or BEEF hex, sign one offline from a key and a saved
  funding transaction, or try a demo payment), then hand it over as a **QR code**, as **sound**,
  or as a **text to a gateway** (an `sms:` link with the payment as the message). Paste the
  gateway's reply to check its signed receipt against the pinned gateway key.
- **Get paid:** **scan** the QR code or **listen** for the sound, and the page checks the
  signatures and that it pays your address the amount you expect. Accepted payments wait in an
  outbox until you text them to a gateway or broadcast them.

Sound uses ggwave (data over sound with error correction): a payment is 3 chunks, about 26 s on
Fast or 14 s on Fastest, and plays twice. QR uses one code for a normal payment (about 360
characters) and a loop of codes for a long one.

```bash
node radio/handoff/build.mjs     # rebuild index.html after changing radio/handoff/src or radio/lib
```

Checked here: in the browser, a demo payment is signed and checked, its QR code decodes back to
the same text, the sound chunks encode and decode back to the same bytes in the page, a gateway
receipt verifies against the pinned key (and is refused for any other key), and the layout holds
at phone width in light and dark. In Node, a payment played into a simulated noisy room and
captured in microphone-sized blocks is rebuilt exactly (`test/radio-sound.test.mjs`). **Not
checked:** a real camera scan and real speaker-to-microphone sound between two phones, and the
`sms:` link on real phones.

## SMS gateway

A payment by text, for phones with no data, including satellite texting where it works.

```
BSV1 E <base64 EF payment>                  one text (about 360 characters: the phone sends 3 joined segments)
BSV1 E 1/4 <id> <part>                      the same payment in parts, for links with short texts
BSV RECEIPT <status> <txid>                 the gateway's reply...
R1 <base64 signed receipt>                  ...with its signed receipt
```

Base64 uses only GSM-7 characters, so a text never drops to 70-character segments. The gateway
checks the payment offline, broadcasts it only with `--spend-real-bsv`, and replies with the
signed receipt. A repeat of the same payment gets the same reply and is not broadcast again.
Texts that are not payments get no reply, so two automated numbers can never loop.

```bash
node radio/sms/server.mjs --key-file gateway.wif --twilio-token-file twilio.token --public-url https://<your host>/twilio
node radio/sms/server.mjs --key-file gateway.wif --android-key-file signing.key --android-device http://<phone ip>:8080 --android-user <user> --android-pass-file android.pass
```

- **Twilio:** point the number's incoming-message webhook at `/twilio`. The `X-Twilio-Signature`
  header is checked (HMAC-SHA1, verified against Twilio's documented example) and the receipt
  goes back as the TwiML reply.
- **Any Android phone with a SIM:** install SMS Gateway for Android
  (github.com/capcom6/android-sms-gateway, open source), point its `sms:received` webhook at
  `/android`, and the receipt goes back through the phone's local API. `X-Signature`
  (HMAC-SHA256 of body + timestamp) is checked, and timestamps more than 5 minutes off are
  refused.

Both webhooks are tested with simulated requests over a real local HTTP server
(`test/radio-sms.test.mjs`). **Not yet run against a live Twilio number or a phone running the
app.**

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
cli.mjs            gateway / send / fetch-fund on real radios (--port or --host)
meshtasticd/       run-sim.sh: two real-firmware nodes in Docker, no radios needed
RESULTS.md         what has been run, and what it does and does not show
run-demo.mjs       the simulated end-to-end demo
lib/sound.mjs      payment as ggwave sound chunks
sms/text.mjs       payment and receipt as SMS text (GSM-7 safe), parts for short texts
sms/gateway.mjs    SMS gateway core: check, broadcast if told, signed receipt reply
sms/server.mjs     webhooks: Twilio and SMS Gateway for Android
handoff/           the phone page (src/ and build.mjs; index.html is the built page)
```
