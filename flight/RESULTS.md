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

## Offline key management onboard: PASS (2026-10-21)

`keyring.c` applies the rules of `spec/KEY-RECORDS.md` on the spacecraft: it reads key and
revocation records (COSE_Sign1, from a Key Record Block or one at a time, in any order),
checks their Ed25519 signatures over the COSE Sig_structure with the same TweetNaCl, and
answers whether a key may sign in a role for a node at a time, and whether a revocation
applies. `keyring-vectors.mjs` builds 7 scenarios with the reference keyring
(`transport/bpv7/keyring.mjs`); `kr_check` answers the same 30 queries in C; every answer is
the same:

```
  valid                          ok                                   SAME
  expired                        key_expired                          SAME
  self_issued                    chain_not_anchored                   SAME
  out_of_order                   ok                                   SAME
  bad_signature                  record_signature_invalid             SAME
  issuer_lacks_role              issuer_lacks_issue_role              SAME
  issued_outside_issuer_window   issuer_not_valid_at_issuance         SAME
  rev_earliest_wins              ok revoked from 846691200000         SAME
  rev_hostile_ignored            ok                                   SAME
  rev_role_other_anchor          ok                                   SAME
  issuer_compromise_thief        issuer_revoked                       SAME
  block_revoked                  ok revoked from 846172800000         SAME
  ... (30 in all, every reason code)
KEYRING_RESULT {"ok":true,"queries":30,"differ":0,"extra":0}
```

| ARM Cortex-M4, `-Os -mthumb` | text | bss |
|---|---|---|
| `keyring.o` | 2,957 B | 704 B (one static verify buffer) |
| one `ck_keyring` (32 records, 4 anchors) | | 16,856 B, caller-owned |

No heap; the keyring is one struct the caller places. Built warning-free with
`-Wall -Wextra -Werror`. Not yet run on flight hardware or inside the cFS app, and receipt
verification itself (block 224) is still done on the ground.
