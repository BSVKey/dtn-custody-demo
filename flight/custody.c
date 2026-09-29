/* Onboard custody records. See custody.h. */
#include "custody.h"
#include "sha256.h"
#include "tweetnacl.h"
#include <string.h>
#include <stdio.h>
#include <stdlib.h>

/* TweetNaCl draws key seeds from randombytes(). Here it is only ever used to load a
 * caller-supplied seed inside ck_key_from_seed; any other call is a programming error. */
static const uint8_t *seed_src = NULL;
void randombytes(unsigned char *x, unsigned long long n) {
  if (!seed_src || n != 32) abort();
  memcpy(x, seed_src, 32);
  seed_src = NULL;
}

static const char B64[] = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
static void b64(const uint8_t *in, size_t n, char *out) {
  size_t o = 0;
  for (size_t i = 0; i < n; i += 3) {
    uint32_t v = (uint32_t)in[i] << 16 | (i + 1 < n ? (uint32_t)in[i+1] << 8 : 0) | (i + 2 < n ? in[i+2] : 0);
    out[o++] = B64[v >> 18 & 63]; out[o++] = B64[v >> 12 & 63];
    out[o++] = i + 1 < n ? B64[v >> 6 & 63] : '=';
    out[o++] = i + 2 < n ? B64[v & 63] : '=';
  }
  out[o] = 0;
}

void ck_hex(const uint8_t *b, size_t n, char *out) {
  static const char H[] = "0123456789abcdef";
  for (size_t i = 0; i < n; i++) { out[2*i] = H[b[i] >> 4]; out[2*i+1] = H[b[i] & 15]; }
  out[2*n] = 0;
}

int ck_key_from_seed(ck_key *k, const uint8_t seed[32]) {
  static const uint8_t SPKI[12] = {0x30,0x2a,0x30,0x05,0x06,0x03,0x2b,0x65,0x70,0x03,0x21,0x00};
  uint8_t der[44];
  if (!k || !seed) return CK_E_ARG;
  seed_src = seed;
  crypto_sign_keypair(k->pk, k->sk);
  memcpy(der, SPKI, 12); memcpy(der + 12, k->pk, 32);
  b64(der, 44, k->pub_b64);
  return 0;
}

void ck_leaf(const uint8_t *bytes, size_t n, uint8_t out[32]) {
  sha256_ctx c; uint8_t d = 0x00;
  sha256_init(&c); sha256_update(&c, &d, 1); sha256_update(&c, bytes, n); sha256_final(&c, out);
}

void ck_node(const uint8_t l[32], const uint8_t r[32], uint8_t out[32]) {
  sha256_ctx c; uint8_t d = 0x01, t[32];
  sha256_init(&c); sha256_update(&c, &d, 1); sha256_update(&c, l, 32); sha256_update(&c, r, 32); sha256_final(&c, t);
  memcpy(out, t, 32);
}

int ck_root(const uint8_t *payload, size_t n, size_t chunk, uint8_t (*s)[32], size_t max_leaves, uint8_t root[32], size_t *count) {
  if (!chunk || !s) return CK_E_ARG;
  size_t cnt = n == 0 ? 1 : (n + chunk - 1) / chunk;
  if (cnt > max_leaves) return CK_E_SPACE;
  if (n == 0) ck_leaf(payload, 0, s[0]);
  for (size_t i = 0; i < cnt && n; i++) ck_leaf(payload + i * chunk, (i + 1) * chunk <= n ? chunk : n - i * chunk, s[i]);
  if (count) *count = cnt;
  for (size_t w = cnt; w > 1; w = (w + 1) / 2)
    for (size_t i = 0; i < w; i += 2) ck_node(s[i], i + 1 < w ? s[i+1] : s[i], s[i/2]); /* odd layer: duplicate last */
  memcpy(root, s[0], 32);
  return 0;
}

/* ---- canonical JSON writer for the fixed record schemas ---------------------------- */
typedef struct { char *p; size_t cap, n; int err; } W;
static void put(W *w, const char *s) {
  size_t l = strlen(s);
  if (w->err) return;
  if (w->n + l + 1 > w->cap) { w->err = CK_E_SPACE; return; }
  memcpy(w->p + w->n, s, l); w->n += l; w->p[w->n] = 0;
}
static int safe(const char *s) {
  if (!s) return 0;
  for (; *s; s++) if (*s < 0x20 || *s > 0x7e || *s == '"' || *s == '\\') return 0;
  return 1;
}
static void kstr(W *w, const char *k, const char *v, int first) {
  if (!safe(v)) { w->err = CK_E_STRING; return; }
  put(w, first ? "\"" : ",\""); put(w, k); put(w, "\":\""); put(w, v); put(w, "\"");
}
static void knum(W *w, const char *k, uint64_t v, int first) {
  char b[24];
  if (v > 9007199254740991ULL) { w->err = CK_E_NUMBER; return; }
  snprintf(b, sizeof b, "%llu", (unsigned long long)v);
  put(w, first ? "\"" : ",\""); put(w, k); put(w, "\":"); put(w, b);
}
static void content_id(const char *canon, char out[CK_ID_LEN + 1]) {
  uint8_t h[32];
  sha256(canon, strlen(canon), h);
  out[0] = '0'; out[1] = 'x'; ck_hex(h, 32, out + 2);
}
/* Ed25519 over the claim id's ASCII bytes, as the reference implementation signs it. */
static void sign_id(const ck_key *k, const char id[CK_ID_LEN + 1], char out[CK_SIG_B64 + 1]) {
  uint8_t sm[64 + CK_ID_LEN]; unsigned long long smlen;
  crypto_sign(sm, &smlen, (const uint8_t *)id, CK_ID_LEN, k->sk);
  b64(sm, 64, out);
}

int ck_bundle_id(const char *payload_id, uint64_t index, const uint8_t leaf[32], char out[CK_ID_LEN + 1]) {
  char buf[512], lh[65]; W w = { buf, sizeof buf, 0, 0 };
  ck_hex(leaf, 32, lh);
  put(&w, "{"); knum(&w, "index", index, 1); kstr(&w, "leafHex", lh, 0); kstr(&w, "payloadId", payload_id, 0); put(&w, "}");
  if (w.err) return w.err;
  content_id(buf, out);
  return 0;
}

int ck_manifest(const ck_key *k, const char *payload_id, uint64_t chunk_count, const uint8_t root[32], uint64_t chunk_size, char *out, size_t cap) {
  char c[512], id[CK_ID_LEN + 1], sig[CK_SIG_B64 + 1], rh[65], meta[48];
  W w = { c, sizeof c, 0, 0 };
  ck_hex(root, 32, rh);
  if (chunk_size > 9007199254740991ULL) return CK_E_NUMBER;
  snprintf(meta, sizeof meta, "{\"chunkSize\":%llu}", (unsigned long long)chunk_size);
  put(&w, "{"); knum(&w, "chunkCount", chunk_count, 1); kstr(&w, "kind", "manifest/1", 0);
  put(&w, ",\"meta\":"); put(&w, meta); kstr(&w, "payloadId", payload_id, 0); kstr(&w, "root", rh, 0); put(&w, "}");
  if (w.err) return w.err;
  content_id(c, id); sign_id(k, id, sig);
  W o = { out, cap, 0, 0 };
  put(&o, "{"); knum(&o, "chunkCount", chunk_count, 1); kstr(&o, "claimId", id, 0); kstr(&o, "kind", "manifest/1", 0);
  put(&o, ",\"meta\":"); put(&o, meta); kstr(&o, "payloadId", payload_id, 0); kstr(&o, "root", rh, 0);
  kstr(&o, "sig", sig, 0); kstr(&o, "signerPub", k->pub_b64, 0); put(&o, "}");
  return o.err;
}

int ck_custody(const ck_key *k, const char *payload_id, const char *bundle_id, const char *prev_hop, const char *this_hop,
               uint64_t received_at, uint64_t forwarded_at, char *out, size_t cap) {
  char c[1024], id[CK_ID_LEN + 1], sig[CK_SIG_B64 + 1];
  W w = { c, sizeof c, 0, 0 };
  put(&w, "{"); kstr(&w, "bundleId", bundle_id, 1); knum(&w, "forwardedAt", forwarded_at, 0); kstr(&w, "kind", "custody/1", 0);
  kstr(&w, "payloadId", payload_id, 0); kstr(&w, "prevHop", prev_hop, 0); knum(&w, "receivedAt", received_at, 0);
  kstr(&w, "thisHop", this_hop, 0); put(&w, "}");
  if (w.err) return w.err;
  content_id(c, id); sign_id(k, id, sig);
  W o = { out, cap, 0, 0 };
  put(&o, "{"); kstr(&o, "bundleId", bundle_id, 1); kstr(&o, "claimId", id, 0); knum(&o, "forwardedAt", forwarded_at, 0);
  kstr(&o, "kind", "custody/1", 0); kstr(&o, "payloadId", payload_id, 0); kstr(&o, "prevHop", prev_hop, 0);
  knum(&o, "receivedAt", received_at, 0); kstr(&o, "sig", sig, 0); kstr(&o, "signerPub", k->pub_b64, 0);
  kstr(&o, "thisHop", this_hop, 0); put(&o, "}");
  return o.err;
}
