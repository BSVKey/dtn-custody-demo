/* C side of bench/overhead.mjs: Ed25519 sign and verify per second, and SHA-256
 * throughput, single thread. Built twice by bench/run-overhead.sh:
 *   -DUSE_TWEETNACL  the flight signer's Ed25519 (TweetNaCl 20140427, as in flight/), key
 *                    loaded through ck_key_from_seed; verify is crypto_sign_open
 *   -DUSE_SODIUM     libsodium, a speed-optimised Ed25519, for comparison
 * SHA-256 is the flight code's portable flight/sha256.c in both builds.
 * The signed message is 128 bytes, about the size of a receipt's COSE Sig_structure.
 * Prints one JSON object. */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include "sha256.h"
#ifdef USE_SODIUM
#include <sodium.h>
#define IMPL "libsodium"
#else
#include "custody.h"
#include "tweetnacl.h"
#define IMPL "tweetnacl"
#endif

static double now_s(void) { struct timespec t; clock_gettime(CLOCK_MONOTONIC, &t); return t.tv_sec + t.tv_nsec / 1e9; }
#define MIN_S 1.0
#define MSG 128

int main(void) {
  static uint8_t msg[MSG], pk[32], sk[64], sig[64], seed[32];
  for (int i = 0; i < MSG; i++) msg[i] = (uint8_t)(i * 37);
  memset(seed, 0x02, 32);
  int n = 0; double t0, el;
#ifdef USE_SODIUM
  if (sodium_init() < 0) return 1;
  crypto_sign_seed_keypair(pk, sk, seed);
  t0 = now_s(); do { crypto_sign_detached(sig, NULL, msg, MSG, sk); n++; el = now_s() - t0; } while (el < MIN_S);
  double sign_ps = n / el;
  if (crypto_sign_verify_detached(sig, msg, MSG, pk) != 0) { fprintf(stderr, "verify failed\n"); return 1; }
  n = 0; t0 = now_s(); do { if (crypto_sign_verify_detached(sig, msg, MSG, pk) != 0) return 1; n++; el = now_s() - t0; } while (el < MIN_S);
  double verify_ps = n / el;
#else
  ck_key k;
  if (ck_key_from_seed(&k, seed)) return 1;
  memcpy(pk, k.pk, 32); memcpy(sk, k.sk, 64);
  static uint8_t sm[MSG + 64], m2[MSG + 64];
  unsigned long long smlen = 0, mlen = 0;
  t0 = now_s(); do { crypto_sign(sm, &smlen, msg, MSG, sk); n++; el = now_s() - t0; } while (el < MIN_S);
  double sign_ps = n / el;
  if (crypto_sign_open(m2, &mlen, sm, smlen, pk) != 0) { fprintf(stderr, "verify failed\n"); return 1; }
  n = 0; t0 = now_s(); do { if (crypto_sign_open(m2, &mlen, sm, smlen, pk) != 0) return 1; n++; el = now_s() - t0; } while (el < MIN_S);
  double verify_ps = n / el;
  (void)sig;
#endif
  printf("{\"impl\":\"%s\",\"messageBytes\":%d,\"signPerSec\":%.1f,\"verifyPerSec\":%.1f,\"sha256\":[", IMPL, MSG, sign_ps, verify_ps);
  const size_t sizes[3] = { 1024, 65536, 1048576 };
  uint8_t *buf = malloc(1048576), out[32];
  if (!buf) return 1;
  for (size_t i = 0; i < 1048576; i++) buf[i] = (uint8_t)(i * 37);
  for (int s = 0; s < 3; s++) {
    n = 0; t0 = now_s(); do { sha256(buf, sizes[s], out); n++; el = now_s() - t0; } while (el < MIN_S);
    printf("%s{\"bytes\":%zu,\"perSec\":%.1f,\"MBps\":%.1f}", s ? "," : "", sizes[s], n / el, n / el * sizes[s] / 1e6);
  }
  /* Batch bookkeeping per bundle, identity-bound: one leaf hash over 0x00 || a 60-byte
   * CBOR bundle identity, plus one interior node hash (0x01 || 32 || 32), which is what a
   * streaming tree costs per leaf on average. */
  uint8_t idbuf[61] = {0x00}, nodebuf[65] = {0x01}, h[32];
  for (int i = 1; i < 61; i++) idbuf[i] = (uint8_t)i;
  n = 0; t0 = now_s();
  do { idbuf[60] = (uint8_t)n; sha256(idbuf, 61, h); memcpy(nodebuf + 1, h, 32); sha256(nodebuf, 65, nodebuf + 33); n++; el = now_s() - t0; } while (el < MIN_S);
  printf("],\"batchLeafPlusNodePerSec\":%.1f}\n", n / el);
  free(buf);
  return 0;
}
