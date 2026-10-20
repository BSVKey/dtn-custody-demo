# Pay over radio: results

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
