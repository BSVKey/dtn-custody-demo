# CUSTODY: a NASA cFS application

The onboard signer from `flight/` packaged as a standard NASA Core Flight System (cFS)
application, so a spacecraft already running cFS can sign data-custody receipts on board
with no new flight framework. Records are byte-identical to the open reference
implementation, so the ground verifies them with the same code.

```
make cfs        # build cFS v7.0.1 with the app, boot it, command it, check the records
```

## What the app does

- **At boot:** registers its events, signs the published `custody/1` test vector with the
  published test key and checks the claim id and signature (`CUSTODY self-test PASS`),
  then loads the vehicle's 32-byte signing seed from `/cf/custody_key.bin`. If the
  self-test fails or no key is present, signing stays disabled.
- **Commands** (MID `0x18F0`):
  - `0` NOOP: reports receipts signed and errors.
  - `1` SIGN: takes payload id, bundle id, previous hop, this hop, received and forwarded
    times; writes one signed canonical-JSON record per file to `/cf/custody_NNNN.json` for
    downlink.
- **Refusals:** a command of the wrong length, a string field without its terminator, or
  a string outside the safe character set is refused with an error event and no record.

| File | What |
|---|---|
| `custody/CMakeLists.txt` | `add_cfe_app(custody ...)` for the cFS build |
| `custody/fsw/inc/custody_app.h` | command MID, function codes, command layout, event IDs |
| `custody/fsw/src/custody_app.c` | the application; signer sources are copied in from `flight/` at build |
| `send-cmd.mjs` | ground-side CCSDS command builder, sent to cFS command ingest (UDP 1234) |
| `run-cfs.sh`, `check.mjs` | the boot, command and check sequence used by `make cfs` |

## Integrating on a mission

1. Copy `custody/` into your cFS `apps/` directory with `flight/custody.c`, `custody.h`,
   `sha256.c`, `sha256.h` and TweetNaCl (`tweetnacl.c`, `tweetnacl.h`) in `fsw/src/`.
2. Add `custody` to your mission app list and a `CFE_APP, custody, CUSTODY_AppMain, ...`
   line to the startup script.
3. Assign a command MID that fits your mission's allocation (default `0x18F0`) and route
   the SIGN command from wherever custody events originate (for example a DTN node app).
4. Provision the vehicle key into protected storage, and register its public key with the
   ground verifiers. The test run uses the published test seed; never fly it.

Not yet done: timing and stack measurement on flight hardware, housekeeping telemetry
packets, table-driven configuration, and a direct hook into NASA's BPNode application.
