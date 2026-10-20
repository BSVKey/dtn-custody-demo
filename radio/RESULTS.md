# Pay over radio: results

## 2026-10-20: a real payment over Nearby (WebRTC), PC and iPhone on one Wi-Fi

An iPhone and a Windows PC on the same home Wi-Fi, both on the live page's Nearby tab. They swapped
the two connection codes as QR codes (the camera held while connecting, so each shared its real
local address), linked directly over the local network, and told each other their addresses. A
real payment was signed in the paying device's wallet, sent over the link (Pay them), received and
checked on the other device, then broadcast from there.

- Transaction [`3d8301a8...c7d234`](https://whatsonchain.com/tx/3d8301a8fea17f98421a2f435da1b56c143ab4d66a7b5f95ffca34ac65c7d234)
  (226 bytes): 1,000 sat to 1ErDfgzGWe6kDSHWWZPUSpVRRvfQo7rDdZ and 36,767,743 sat change back to
  the payer. Mined in block 971849.

What this proves: two different devices (Safari on iOS, Chrome on Windows) can link over a local
network with no server, using only QR codes to set up, and carry a real payment that the network
then mines.

Found and fixed during the test: the first attempt could not connect, because without camera or
microphone access browsers hide their local address behind a random `.local` name, which Safari
and Chrome could not resolve for each other (fixed: the camera is held while connecting); scanning
the answer twice threw an error (now harmless); and the paying device had to type an address the
link could have shared (now shared automatically).

What it does not prove: a phone's hotspot with no internet at all, or networks that keep devices
apart (guest Wi-Fi).

## 2026-10-20: a real faucet, announced by sound, claimed from a phone

A bearer faucet on Bitcoin BSV mainnet (`radio/faucet/`), run end to end with real money.

1. A faucet key was funded with 6,000 sat ([`e7fdaba0...747ceb`](https://whatsonchain.com/tx/e7fdaba070a15ab2f52dd77c06dc07bf88c8b75071f9be7203efe2c539747ceb)).
2. `faucet/cli.mjs build --mode bearer` made the fan-out: 5 coins of 1,000 sat, a faucet tag and
   958 sat change, 411 bytes, 42 sat fee ([`2acbf8c0...d8bd40`](https://whatsonchain.com/tx/2acbf8c082e8247e75d18513b5e656bb51064280c263ec91577b434817d8bd40)).
   It was not broadcast from the computer: its QR code was scanned with an iPhone's camera app,
   which opened the live page with it loaded, and it was kept to forward and broadcast from the
   phone (Broadcast now). Mined in block 971845.
3. `faucet/cli.mjs announce --wav` made the announcement as sound (the faucet line and the 5 coin
   lines, 53 seconds) and it was played from the computer's speaker. The iPhone page, on Listen,
   heard the coins under Faucets heard.
4. Two coins were swept on the phone (Sweep to my address) and broadcast from it: coin 3
   ([`437bb04b...598f36`](https://whatsonchain.com/tx/437bb04bf37fb40611b87ab4b34c65696c82b6c8a18c17eafcfea9d894598f36)) and coin 4
   ([`f8a0541d...2f76e1`](https://whatsonchain.com/tx/f8a0541d6fe71fd7f4a476209ad0045fca772b5dbe8e64bb8dee5f50d92f76e1)), each 980 sat to
   1ErDfgzGWe6kDSHWWZPUSpVRRvfQo7rDdZ, both mined in block 971846. Coins 1 and 2 were later swept
   from the phone as well; coin 0 was left unclaimed.

What this proves: a faucet's coins can be created, announced over sound, picked up by a phone's
microphone, claimed and sent to the network from the phone, with real money; and a signed
transaction can be carried to a phone by QR code and broadcast from there (the courier path).

Found and fixed during the test: a swept coin went through the payment check, so a leftover
"amount you expect" of 1,000 sat kept the 980 sat coin out of the outbox (fixed: sweeps go
straight to it); the phone's camera app treated the page's QR codes as text to search (fixed:
QR codes are now links that open the page with the payment); and a sent payment vanished from the
list (fixed: it stays with its WhatsOnChain link).

What it does not prove: claims mode (texted claims and the faucet's limits) with real money, or
the announcement over a walkie-talkie, AM or FM radio, or a phone call.

## 2026-10-20: a real Bitcoin BSV payment carried by sound, then mined on mainnet

A manual test on the live page (dtn.bsvkey.com/radio/), with two wallets each open in its own
copy of the page. The payer's wallet was loaded (Send real BSV), its coins read from
WhatsOnChain, and the payment signed in the page. It was then played as sound (Play as sound)
and heard by the other wallet's page (Listen), which rebuilt and checked it. Afterwards it was
broadcast to the network with Broadcast now (GorillaPool ARC).

- Transaction [`5a15bdc5...9b25ac`](https://whatsonchain.com/tx/5a15bdc5da061016d21d1eabf9e983fc7b7a7a4e0fc9892c35c8e628139b25ac)
  (225 bytes), mined in block 971842 on 2026-10-20.
- Pays 1,000 sat to 1ErDfgzGWe6kDSHWWZPUSpVRRvfQo7rDdZ, with 109,902,789 sat change back to the
  payer's own address, and a 23 sat fee, all as the page showed before sending.
- ARC answered `SEEN_ON_NETWORK` on broadcast; WhatsOnChain then showed it in the block.

What this proves: a real, spendable payment can go from one wallet's page to another's as sound,
arrive intact and checkable, and then be broadcast and mined. It also exercises the page's wallet
import, coin lookup, signing (one coin in, change and fee worked out in the page) and broadcast.

What it does not prove: the other handoffs with real money (QR code scan, text message to a
gateway, LoRa radio), or sound over a walkie-talkie, AM or FM radio, or a phone call. The chain
records the broadcast and the block; the sound handoff before it is from the test's own report.

## 2026-10-19: real Meshtastic firmware, simulated radio (meshtasticd)

Two Meshtastic nodes in Docker (`meshtastic/meshtasticd`, firmware 2.7.26.54e0d8d, `--sim`),
linked by Meshtastic's UDP LAN mesh (`network.enabled_protocols = 1`). Each had `radio/cli.mjs`
attached over TCP with `--host`: one as payer, one as gateway. Dry run, synthetic funding. The
script is `radio/meshtasticd/run-sim.sh`.

```
gateway up on radio !4583c707; receipt key 020f5ee9...2663e8
dry run: payments are checked, never broadcast (add --spend-real-bsv to send)
signed 4a45652f...b50b70 offline: 1000 sat to 1BgGZ9tc...SAMH, fee 23 sat
sending EF payment, 265 B in 2 frames
payment 4a45652f...b50b70: valid, not broadcast (dry run: checked, not broadcast)    (gateway)
receipt from the gateway: VALID_NOT_SENT for 4a45652f...b50b70                       (payer, about 1 s after sending)
```

What this proves: the bridge, the official Meshtastic Python library, and the firmware's
PRIVATE_APP port carry our frames both ways unchanged. The payment was rebuilt and checked, and
the gateway's receipt verified against the pinned key.

What it does not prove: LoRa airtime, range, or loss. The packets crossed by UDP, not over the
air. Two physical radios are the next step.
