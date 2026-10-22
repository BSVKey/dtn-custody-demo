/* Answers keyring queries from scenario lines on stdin, one answer per query on stdout:
 *   N <skew_ms>                      start a new keyring
 *   A <pub hex> <eid or ->           add an anchor
 *   R <seen_at> <record hex>         add one record (COSE_Sign1)
 *   B <seen_at> <block data hex>     ingest a Key Record Block's data
 *   Q <name> <pub hex> <eid> <t> <role>
 * Output: "<name> <ok> <reason> <revoked_from or ->". Used by flight/check-keyring.mjs. */
#include "keyring.h"
#include "custody.h"
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static ck_keyring kr;
static char line[1 << 17];
static uint8_t buf[1 << 16];

static long unhex(const char *h, uint8_t *out, size_t cap) {
  size_t n = strlen(h);
  if (n % 2 || n / 2 > cap) return -1;
  for (size_t i = 0; i < n / 2; i++) {
    unsigned v;
    if (sscanf(h + 2 * i, "%2x", &v) != 1) return -1;
    out[i] = (uint8_t)v;
  }
  return (long)(n / 2);
}

int main(void) {
  ck_kr_init(&kr, 0);
  while (fgets(line, sizeof line, stdin)) {
    line[strcspn(line, "\r\n")] = 0;
    char *tok = strtok(line, " ");
    if (!tok) continue;
    if (!strcmp(tok, "N")) {
      ck_kr_init(&kr, strtoull(strtok(NULL, " "), NULL, 10));
    } else if (!strcmp(tok, "A")) {
      uint8_t pub[32]; const char *h = strtok(NULL, " "), *eid = strtok(NULL, " ");
      if (unhex(h, pub, 32) != 32 || ck_kr_anchor(&kr, pub, strcmp(eid, "-") ? eid : "")) { puts("ERROR anchor"); return 1; }
    } else if (!strcmp(tok, "R") || !strcmp(tok, "B")) {
      uint64_t seen = strtoull(strtok(NULL, " "), NULL, 10);
      long n = unhex(strtok(NULL, " "), buf, sizeof buf);
      int rc = n < 0 ? -1 : tok[0] == 'R' ? ck_kr_add(&kr, buf, (size_t)n, seen) : ck_kr_ingest_block(&kr, buf, (size_t)n, seen);
      if (rc < 0) { printf("ERROR %s %d\n", tok, rc); return 1; }
    } else if (!strcmp(tok, "Q")) {
      const char *name = strtok(NULL, " "), *h = strtok(NULL, " "), *eid = strtok(NULL, " ");
      uint64_t t = strtoull(strtok(NULL, " "), NULL, 10);
      uint32_t role = (uint32_t)strtoul(strtok(NULL, " "), NULL, 10);
      uint8_t pub[32];
      if (unhex(h, pub, 32) != 32) { puts("ERROR query"); return 1; }
      ck_kr_result st;
      ck_kr_status(&kr, pub, eid, t, role, &st);
      if (st.revoked) printf("%s %d %s %llu\n", name, st.ok, ck_kr_reason(st.reason), (unsigned long long)st.revoked_from);
      else printf("%s %d %s -\n", name, st.ok, ck_kr_reason(st.reason));
    }
  }
  return 0;
}
