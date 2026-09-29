# CUSTODY cFS application: PASS

Run 2026-09-29. Reproduce: `make cfs`. NASA cFS bundle `v7.0.1` (cFE, OSAL, PSP, lab
apps), native Linux build, run in Docker with `--sysctl fs.mqueue.msg_max=256` (cFS
needs deeper POSIX message queues than the container default).

```
[cfs] cFS v7.0.1, events from the CUSTODY app:
        CUSTODY 1: CUSTODY app initialized, command MID 0x18F0
        CUSTODY 2: CUSTODY self-test PASS: test-vector claim id and signature reproduced
        CUSTODY 3: CUSTODY signing key loaded, pub MCowBQYDK2VwAyEAgTl3Dqh9F19Wo1Rmw0x+zMuNipG07jeiXfYPW4/Js5Q=
        CUSTODY 6: CUSTODY NOOP: 0 signed, 0 errors
        CUSTODY 4: CUSTODY receipt 1 signed to /cf/custody_0001.json, claimId 0x7fee5ec33f2b8bbe...
        CUSTODY 4: CUSTODY receipt 2 signed to /cf/custody_0002.json, claimId 0x4b9d015c7ea287b5...
        CUSTODY 5: CUSTODY sign: unterminated string field
        CUSTODY 5: CUSTODY sign: record refused (code -1)
        CUSTODY 6: CUSTODY NOOP: 2 signed, 2 errors
  self-test passed at boot inside cFS                        PASS
  exactly two records written (bad commands refused)         PASS
  record 1 identical to the published custody/1 vector       PASS
  record 2 verifies with the reference verifier              PASS
  unterminated field refused with an error event             PASS
  unsafe string refused with an error event                  PASS
  NOOP reports 2 signed, 2 errors                            PASS
CFS_RESULT {"ok":true,"records":2}
=== CFS exit: 0 ===
```

Commands travel the normal cFS path: a CCSDS command packet from the ground tool into
the command ingest app (`ci_lab`, UDP), onto the software bus, to the CUSTODY app. The
first SIGN command uses the published test-vector inputs with the published test key, and
the record written to `/cf` is identical to `spec/test-vectors.json`, signature included.

Scope: this is cFS on a desktop Linux build, not flight hardware. Timing, stack depth and
behavior on a flight processor are still to be measured.
