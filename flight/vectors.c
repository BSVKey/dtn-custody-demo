/* Reproduce the published test vectors (spec/test-vectors.json) from C, then time
 * signing. Prints one JSON object; flight/check.mjs compares it with the vectors. */
#include "custody.h"
#include <stdio.h>
#include <string.h>
#include <time.h>

static double now_s(void) { struct timespec t; clock_gettime(CLOCK_MONOTONIC, &t); return t.tv_sec + t.tv_nsec / 1e9; }

int main(void) {
  uint8_t s1[32], s2[32], scratch[64][32], root[32], leaves3[3][32], mroot[32];
  ck_key src, relay;
  char rec_m[1024], rec_c[1024], rec_b[1024], bid[CK_ID_LEN + 1], hex[65];
  static char ids[3][CK_ID_LEN + 1];
  static uint8_t leaves[3][32], bscratch[1024][32];
  memset(s1, 0x01, 32); memset(s2, 0x02, 32);
  if (ck_key_from_seed(&src, s1) || ck_key_from_seed(&relay, s2)) return 1;

  /* Merkle vector: leaves "alpha", "beta", "gamma". */
  const char *words[3] = {"alpha", "beta", "gamma"};
  for (int i = 0; i < 3; i++) ck_leaf((const uint8_t *)words[i], strlen(words[i]), leaves3[i]);
  memcpy(scratch, leaves3, sizeof leaves3);
  uint8_t l01[32], l22[32];
  ck_node(leaves3[0], leaves3[1], l01); ck_node(leaves3[2], leaves3[2], l22); ck_node(l01, l22, mroot);

  /* Record vectors: 4 x "test-vector payload: 0123456789abcdef", 64-byte chunks. */
  char payload[256] = "";
  for (int i = 0; i < 4; i++) strcat(payload, "test-vector payload: 0123456789abcdef");
  size_t count = 0;
  if (ck_root((const uint8_t *)payload, strlen(payload), 64, scratch, 64, root, &count)) return 1;
  if (ck_manifest(&src, "0xvector-001", count, root, 64, rec_m, sizeof rec_m)) return 1;
  uint8_t leaf1[32];
  ck_leaf((const uint8_t *)payload + 64, 64, leaf1);
  if (ck_bundle_id("0xvector-001", 1, leaf1, bid)) return 1;
  if (ck_custody(&relay, "0xvector-001", bid, "dtn://source/", "dtn://relaya/", 1000, 1050, rec_c, sizeof rec_c)) return 1;

  /* Batch vector: the three chunk bundle ids, one custody-batch/1 signed by the relay. */
  for (int i = 0; i < 3; i++) {
    ck_leaf((const uint8_t *)payload + 64 * i, i < 2 ? 64 : strlen(payload) - 128, leaves[i]);
    if (ck_bundle_id("0xvector-001", i, leaves[i], ids[i])) return 1;
  }
  const char *idp[3] = { ids[1], ids[0], ids[2] };
  if (ck_batch(&relay, "dtn://source/", "dtn://relaya/", "vector-contact-1", 1000, 1100, idp, 3, bscratch, rec_b, sizeof rec_b)) return 1;

  /* Guard rails: a quote or a control character must be refused, not escaped. */
  char tmp[1024];
  int bad_quote = ck_custody(&relay, "p", bid, "dtn://a\"b/", "x", 1, 2, tmp, sizeof tmp);
  int bad_num = ck_custody(&relay, "p", bid, "a", "b", 9007199254740992ULL, 2, tmp, sizeof tmp);
  int small = ck_custody(&relay, "0xvector-001", bid, "dtn://source/", "dtn://relaya/", 1000, 1050, tmp, 64);

  /* Timing: custody receipts signed per second on this CPU. */
  int n = 0; double t0 = now_s(), el;
  do { ck_custody(&relay, "0xvector-001", bid, "dtn://source/", "dtn://relaya/", 1000, 1050 + n, tmp, sizeof tmp); n++; el = now_s() - t0; } while (el < 1.0);

  printf("{\"merkle\":{\"leafHashes\":[");
  for (int i = 0; i < 3; i++) { ck_hex(leaves3[i], 32, hex); printf("%s\"%s\"", i ? "," : "", hex); }
  ck_hex(mroot, 32, hex); printf("],\"root\":\"%s\"},", hex);
  printf("\"pubs\":{\"source\":\"%s\",\"relay\":\"%s\"},", src.pub_b64, relay.pub_b64);
  printf("\"manifest\":%s,\"custody\":%s,", rec_m, rec_c);
  printf("\"guards\":{\"quoteRefused\":%d,\"numberRefused\":%d,\"smallBufferRefused\":%d},", bad_quote == CK_E_STRING, bad_num == CK_E_NUMBER, small == CK_E_SPACE);
  /* Timing: one batch receipt over 1,000 bundle ids (a busy contact). */
  static char many[1000][CK_ID_LEN + 1];
  static const char *mp[1000];
  int nb = 0;
  double tb0 = now_s(), elb;
  do {
    for (int i = 0; i < 1000; i++) { snprintf(many[i], sizeof many[i], "0x%064d", (i * 7919 + nb) % 1000003); mp[i] = many[i]; }
    ck_batch(&relay, "ipn:1001.0", "ipn:1002.0", "c", 1, 2, mp, 1000, bscratch, tmp, sizeof tmp);
    nb++;
    elb = now_s() - tb0;
  } while (elb < 1.0);
  printf("\"batch\":%s,", rec_b);
  printf("\"timing\":{\"custodyReceiptsPerSec\":%.0f,\"batchOf1000PerSec\":%.1f}}\n", n / el, nb / elb);
  return 0;
}
