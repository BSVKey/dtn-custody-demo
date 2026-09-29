# Onboard signing in C

Custody records produced on the spacecraft, in portable C99 with no heap and no
operating-system services, byte-identical to the reference implementation. A record
signed on board verifies with the same public verifier as one signed on the ground.

```
make flight      # build, reproduce the published test vectors, time signing, size for Cortex-M4
```

| File | What |
|---|---|
| `custody.h`, `custody.c` | key from seed, Merkle leaf/node/root, `bundleId`, signed `manifest/1` and `custody/1` records as canonical JSON |
| `sha256.c`, `sha256.h` | SHA-256 (FIPS 180-4), allocation-free |
| `vectors.c` | reproduces `spec/test-vectors.json` and times signing |
| `check.mjs` | compares the C output with the vectors and verifies it with the reference verifier |

Ed25519 comes from TweetNaCl (public domain), fetched from its authors' site at build
time and pinned by SHA-256. It is chosen for size and auditability; a faster Ed25519
can be swapped in behind the same calls.

## As a NASA cFS application

`flight/cfs/` packages this signer as a standard cFS app (CUSTODY): it self-tests against
the published vectors at boot and signs receipts on command over the software bus.
`make cfs` builds cFS v7.0.1 with it and checks the output.

## Integration notes

- **Keys.** `ck_key_from_seed` takes a 32-byte seed the caller reads from protected
  storage. TweetNaCl's `randombytes` hook is only ever used to load that seed; any other
  call aborts, so the library can never silently draw keys from a weak source.
- **Inputs.** Record strings are limited to printable ASCII without `"` or `\`, and
  integers to 0 to 2^53-1, so canonical JSON needs no escaping and a hostile string cannot
  change a record's structure. Violations return an error code; nothing is truncated.
- **Buffers.** Callers pass output buffers and sizes; a short buffer returns `CK_E_SPACE`.
  `ck_root` works in a caller-supplied scratch array, one 32-byte hash per chunk.
- **Not yet done.** No flight qualification, no measured stack depth, and no timing on
  a flight processor. These are the next measurements on target hardware.
