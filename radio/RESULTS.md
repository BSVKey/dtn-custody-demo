# Pay over radio: results

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
