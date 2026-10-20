# Pay over radio: results

## 2026-10-20: a real Bitcoin BSV payment from the phone page, mined on mainnet

A wallet was loaded into the live page (dtn.bsvkey.com/radio/, Send real BSV), its coins read
from WhatsOnChain, and a payment signed in the page and sent with Broadcast now (GorillaPool ARC).

- Transaction [`5a15bdc5...9b25ac`](https://whatsonchain.com/tx/5a15bdc5da061016d21d1eabf9e983fc7b7a7a4e0fc9892c35c8e628139b25ac)
  (225 bytes), mined in block 971842 on 2026-10-20.
- Pays 1,000 sat to 1ErDfgzGWe6kDSHWWZPUSpVRRvfQo7rDdZ, with 109,902,789 sat change back to the
  payer's own address, and a 23 sat fee, all as the page showed before sending.
- ARC answered `SEEN_ON_NETWORK` on broadcast; WhatsOnChain then showed it in the block.

What this proves: the page's wallet import, its coin lookup, its signing (one coin in, change
and fee worked out in the page) and its broadcast produce a valid mainnet payment.

What it does not prove: the offline handoffs. This payment went straight from the payer's page
to the network. A real payment carried by QR code, sound, text message or radio, then forwarded
by the payee, is still to be done.

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
