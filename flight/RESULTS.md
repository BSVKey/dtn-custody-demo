# Onboard signing in C: PASS

Run 2026-09-30 (batch receipts added; first run 2026-09-29). Reproduce: `make flight`.

```
[flight] TweetNaCl sha256:
          02e65bc3013ff2168983365e55906bc783c4c7e0a60d8100f17bb303a17175c4  tweetnacl.c
          43f29ad721d9927b747b0100ab4160c119e7bb180c7c98a66e4bf79d31244287  tweetnacl.h
  Merkle leaf hashes match                             PASS
  Merkle root matches                                  PASS
  public keys from seeds match                         PASS
  manifest/1 record identical, signature included      PASS
  custody/1 record identical, signature included       PASS
  custody-batch/1 record identical, signature included PASS
  records verify with the reference verifier           PASS
  unsafe strings, oversize numbers, short buffers refused PASS
FLIGHT_RESULT {"ok":true,"custodyReceiptsPerSec":1045,"batchOf1000PerSec":476.8}
[flight] ARM Cortex-M4 (arm-none-eabi-gcc -Os -mthumb), code and data per object:
             text	   data	    bss	    dec	    hex	filename
             2983	      0	      4	   2987	    bab	/tmp/custody.o
              948	      0	      0	    948	    3b4	/tmp/sha256.o
             8369	      0	      0	   8369	   20b1	/tmp/tweetnacl.o
            12300	      0	      4	  12304	   3010	(TOTALS)
=== FLIGHT exit: 0 ===
```

What this shows:

- **Byte-identical.** From the published test seeds, the C code produces the same
  public keys, Merkle hashes, record ids and Ed25519 signatures as the reference
  implementation. Records signed on board and on the ground are interchangeable.
- **Batch receipts on board.** `ck_batch` signs one `custody-batch/1` record for a whole
  contact, identical to the published vector. One batch over 1,000 bundle ids (sort,
  1,000 leaf hashes, the tree, one signature) takes about 2 ms on one desktop core, so a
  busy satellite signs once per contact rather than once per bundle.
- **Small.** About 12.3 KB of code for an ARM Cortex-M4 (Thumb, `-Os`), before the C
  library routines it links (`memcpy`, `snprintf`); no initialized data, 4 bytes of
  static state.
- **Speed.** About 1,000 custody receipts per second on one desktop core (a second run
  gave 1,021). TweetNaCl trades speed for size: the Node reference on the same machine
  signs about 30,000 per second (`bench/RESULTS.md`). A flight processor will be slower
  than either and must be measured; at one receipt per bundle, even tens per second
  covers typical small-spacecraft bundle rates.

Not claimed: flight qualification, radiation behavior, measured stack depth, or timing
on target hardware.
