/* Onboard offline key management. See keyring.h and spec/KEY-RECORDS.md. */
#include "keyring.h"
#include "custody.h"
#include "sha256.h"
#include "tweetnacl.h"
#include <string.h>

#define MAX_DEPTH 6
#define MAX_CHAIN (MAX_DEPTH + 2)
#define NONE UINT64_MAX

static const char *const REASONS[] = {
  "ok", "key_unknown", "chain_not_anchored", "chain_too_long", "issuer_lacks_issue_role",
  "record_signature_invalid", "issuer_not_valid_at_issuance", "issuer_revoked",
  "key_not_for_this_node", "key_lacks_role", "key_expired", "key_not_yet_valid",
};
const char *ck_kr_reason(int r) { return r >= 0 && r <= CK_KR_KEY_NOT_YET_VALID ? REASONS[r] : "?"; }

void ck_kr_keyid(const uint8_t pub[32], uint8_t id[16]) {
  uint8_t h[32];
  sha256(pub, 32, h);
  memcpy(id, h, 16);
}

void ck_kr_init(ck_keyring *kr, uint64_t skew_ms) { memset(kr, 0, sizeof *kr); kr->skew_ms = skew_ms; }

int ck_kr_anchor(ck_keyring *kr, const uint8_t pub[32], const char *eid) {
  if (!kr || !pub) return CK_E_ARG;
  if (kr->n_anchors >= CK_KR_MAX_ANCHORS) return CK_E_SPACE;
  ck_anchor *a = &kr->anchors[kr->n_anchors];
  memcpy(a->pub, pub, 32);
  ck_kr_keyid(pub, a->id);
  a->eid[0] = 0;
  if (eid) { if (strlen(eid) >= CK_KR_MAX_EID) return CK_E_STRING; strcpy(a->eid, eid); }
  kr->n_anchors++;
  return 0;
}

/* ---- Minimal CBOR reader (definite lengths only) ------------------------------------- */
typedef struct { const uint8_t *p; size_t n, i; } R;
static int head(R *r, int *major, uint64_t *val) {
  if (r->i >= r->n) return -1;
  uint8_t b = r->p[r->i++];
  int ai = b & 31, len;
  *major = b >> 5;
  if (ai < 24) { *val = (uint64_t)ai; return 0; }
  if (ai == 24) len = 1; else if (ai == 25) len = 2; else if (ai == 26) len = 4; else if (ai == 27) len = 8; else return -1;
  if (r->n - r->i < (size_t)len) return -1;
  uint64_t v = 0;
  for (int k = 0; k < len; k++) v = v << 8 | r->p[r->i++];
  *val = v;
  return 0;
}
static int bytes(R *r, int want_major, const uint8_t **out, size_t *len) {
  int m; uint64_t v;
  if (head(r, &m, &v) || m != want_major || v > r->n - r->i) return -1;
  *out = r->p + r->i; *len = (size_t)v; r->i += (size_t)v;
  return 0;
}

/* One COSE_Sign1 [protected bstr, {} , payload bstr, signature bstr] -> record. */
static int parse_item(R *r, ck_record *rec) {
  int m; uint64_t v; const uint8_t *prot, *pl, *sig; size_t lp, lpl, ls;
  if (head(r, &m, &v) || m != 4 || v != 4) return -1;
  if (bytes(r, 2, &prot, &lp)) return -1;
  if (head(r, &m, &v) || m != 5 || v != 0) return -1;
  if (bytes(r, 2, &pl, &lpl) || bytes(r, 2, &sig, &ls) || ls != 64 || lpl > CK_KR_MAX_PAYLOAD) return -1;
  memset(rec, 0, sizeof *rec);
  rec->alg_ok = lp == 3 && prot[0] == 0xa1 && prot[1] == 0x01 && prot[2] == 0x27;
  memcpy(rec->sig, sig, 64); memcpy(rec->payload, pl, lpl); rec->plen = (uint16_t)lpl;
  /* The payload map: integer keys, values uint, text or bytes. */
  R q = { pl, lpl, 0 };
  uint64_t count;
  if (head(&q, &m, &count) || m != 5) return -1;
  for (uint64_t k = 0; k < count; k++) {
    uint64_t key, num = 0; const uint8_t *s = NULL; size_t sl = 0;
    if (head(&q, &m, &key) || m != 0) return -1;
    size_t at = q.i;
    if (head(&q, &m, &num)) return -1;
    if (m == 2 || m == 3) { q.i = at; if (bytes(&q, m, &s, &sl)) return -1; }
    else if (m != 0) return -1;
    switch (key) {
      case 1: rec->kind = (uint8_t)num; break;
      case 2: if (!s || sl >= CK_KR_MAX_EID) return -1; memcpy(rec->subject, s, sl); rec->subject[sl] = 0; break;
      case 3: if (!s || sl != 32) return -1; memcpy(rec->pub, s, 32); ck_kr_keyid(rec->pub, rec->keyid); break;
      case 4: rec->roles = (uint32_t)num; break;
      case 5: rec->not_before = num; break;
      case 6: rec->not_after = num; break;
      case 7: rec->issued_at = num; break;
      case 8: if (!s || sl != 16) return -1; memcpy(rec->issuer, s, 16); break;
      case 10: if (!s || sl != 16) return -1; memcpy(rec->target, s, 16); break;
      case 11: rec->effective_from = num; break;
      default: break; /* 9 replaces, 12 reason: not needed for decisions */
    }
  }
  return rec->kind == 1 || rec->kind == 2 ? 0 : -1;
}

int ck_kr_add(ck_keyring *kr, const uint8_t *item, size_t n, uint64_t seen_at) {
  if (!kr || !item) return CK_E_ARG;
  R r = { item, n, 0 };
  ck_record rec;
  if (parse_item(&r, &rec) || r.i != n) return CK_E_ARG;
  for (size_t i = 0; i < kr->n_records; i++) {
    ck_record *o = &kr->records[i];
    if (o->plen == rec.plen && !memcmp(o->payload, rec.payload, rec.plen) && !memcmp(o->sig, rec.sig, 64) && o->alg_ok == rec.alg_ok) {
      if (seen_at < o->seen_at) o->seen_at = seen_at;
      return 0;
    }
  }
  if (kr->n_records >= CK_KR_MAX_RECORDS) return CK_E_SPACE;
  rec.seen_at = seen_at;
  kr->records[kr->n_records++] = rec;
  return 1;
}

int ck_kr_ingest_block(ck_keyring *kr, const uint8_t *data, size_t n, uint64_t seen_at) {
  R r = { data, n, 0 };
  int m; uint64_t count; int added = 0;
  if (head(&r, &m, &count) || m != 4) return CK_E_ARG;
  for (uint64_t k = 0; k < count; k++) {
    size_t start = r.i;
    ck_record tmp;
    if (parse_item(&r, &tmp)) return CK_E_ARG;
    int a = ck_kr_add(kr, data + start, r.i - start, seen_at);
    if (a < 0) return a;
    added += a;
  }
  return added;
}

/* ---- COSE_Sign1 check: Ed25519 over ["Signature1", h'a10127', h'', payload] ---------- */
static uint8_t sm_buf[64 + 32 + CK_KR_MAX_PAYLOAD], m_buf[sizeof sm_buf];
static int verify(const ck_record *rec, const uint8_t pub[32]) {
  static const uint8_t PREFIX[] = { 0x84, 0x6a, 'S','i','g','n','a','t','u','r','e','1', 0x43, 0xa1, 0x01, 0x27, 0x40 };
  if (!rec->alg_ok) return 0;
  size_t o = 64;
  memcpy(sm_buf, rec->sig, 64);
  memcpy(sm_buf + o, PREFIX, sizeof PREFIX); o += sizeof PREFIX;
  if (rec->plen < 24) sm_buf[o++] = (uint8_t)(0x40 | rec->plen);
  else if (rec->plen < 256) { sm_buf[o++] = 0x58; sm_buf[o++] = (uint8_t)rec->plen; }
  else { sm_buf[o++] = 0x59; sm_buf[o++] = (uint8_t)(rec->plen >> 8); sm_buf[o++] = (uint8_t)rec->plen; }
  memcpy(sm_buf + o, rec->payload, rec->plen); o += rec->plen;
  unsigned long long mlen;
  return crypto_sign_open(m_buf, &mlen, sm_buf, o, pub) == 0;
}

/* ---- The rules ------------------------------------------------------------------------ */
typedef struct { int ok, reason; int rec; int anchor; uint32_t roles; uint8_t chain[MAX_CHAIN][16]; int n_chain; } chain_t;

static int anchor_of(const ck_keyring *kr, const uint8_t id[16]) {
  for (size_t i = 0; i < kr->n_anchors; i++) if (!memcmp(kr->anchors[i].id, id, 16)) return (int)i;
  return -1;
}
static const uint8_t *pub_of(const ck_keyring *kr, const uint8_t id[16]) {
  int a = anchor_of(kr, id);
  if (a >= 0) return kr->anchors[a].pub;
  for (size_t i = 0; i < kr->n_records; i++)
    if (kr->records[i].kind == 1 && !memcmp(kr->records[i].keyid, id, 16)) return kr->records[i].pub;
  return NULL;
}
static int in_window(const ck_keyring *kr, const ck_record *f, uint64_t t) {
  uint64_t lo = f->not_before > kr->skew_ms ? f->not_before - kr->skew_ms : 0;
  return t >= lo && t <= f->not_after + kr->skew_ms;
}

static uint64_t revoked_from(const ck_keyring *kr, const uint8_t id[16], int depth);

static void chain_of(const ck_keyring *kr, const uint8_t id[16], int depth, chain_t *out) {
  memset(out, 0, sizeof *out);
  int a = anchor_of(kr, id);
  if (a >= 0) {
    out->ok = 1; out->rec = -1; out->anchor = a; out->roles = CK_ROLE_CUSTODY | CK_ROLE_ISSUE | CK_ROLE_REVOKE;
    memcpy(out->chain[0], id, 16); out->n_chain = 1;
    return;
  }
  if (depth >= MAX_DEPTH) { out->reason = CK_KR_CHAIN_TOO_LONG; return; }
  int found = 0, last = CK_KR_KEY_UNKNOWN;
  for (size_t i = 0; i < kr->n_records; i++) {
    const ck_record *r = &kr->records[i];
    if (r->kind != 1 || memcmp(r->keyid, id, 16)) continue;
    found = 1;
    chain_t up;
    chain_of(kr, r->issuer, depth + 1, &up);
    if (!up.ok) { last = up.reason; continue; }
    if (!(up.roles & CK_ROLE_ISSUE)) { last = CK_KR_ISSUER_LACKS_ISSUE_ROLE; continue; }
    if (!verify(r, pub_of(kr, r->issuer))) { last = CK_KR_RECORD_SIGNATURE_INVALID; continue; }
    if (up.rec >= 0 && !in_window(kr, &kr->records[up.rec], r->issued_at)) { last = CK_KR_ISSUER_NOT_VALID_AT_ISSUANCE; continue; }
    uint64_t T = revoked_from(kr, r->issuer, depth + 1);
    if (T != NONE && !(r->seen_at < T)) { last = CK_KR_ISSUER_REVOKED; continue; }
    out->ok = 1; out->rec = (int)i; out->anchor = up.anchor; out->roles = r->roles;
    memcpy(out->chain[0], id, 16);
    for (int k = 0; k < up.n_chain && k + 1 < MAX_CHAIN; k++) memcpy(out->chain[k + 1], up.chain[k], 16);
    out->n_chain = up.n_chain + 1 < MAX_CHAIN ? up.n_chain + 1 : MAX_CHAIN;
    return;
  }
  out->reason = found ? last : depth ? CK_KR_CHAIN_NOT_ANCHORED : CK_KR_KEY_UNKNOWN;
}

static uint64_t revoked_from(const ck_keyring *kr, const uint8_t id[16], int depth) {
  if (depth >= MAX_DEPTH) return NONE;
  uint64_t T = NONE;
  chain_t target;
  chain_of(kr, id, depth + 1, &target);
  const uint8_t *target_pub = pub_of(kr, id);
  for (size_t i = 0; i < kr->n_records; i++) {
    const ck_record *r = &kr->records[i];
    if (r->kind != 2 || memcmp(r->target, id, 16)) continue;
    const uint8_t *signer_pub = pub_of(kr, r->issuer);
    if (!signer_pub || !verify(r, signer_pub)) continue;
    int allowed = 0;
    if (!memcmp(r->issuer, id, 16)) allowed = target_pub != NULL;                     /* self-revocation */
    else {
      if (target.ok) for (int k = 0; k < target.n_chain; k++) if (!memcmp(target.chain[k], r->issuer, 16)) allowed = 1;
      if (!allowed && anchor_of(kr, r->issuer) >= 0) allowed = 1;                      /* an anchor */
      if (!allowed) {                                                                  /* revoke role, same anchor */
        chain_t s;
        chain_of(kr, r->issuer, depth + 1, &s);
        allowed = s.ok && (s.roles & CK_ROLE_REVOKE) && target.ok && s.anchor == target.anchor;
      }
    }
    if (allowed && (T == NONE || r->effective_from < T)) T = r->effective_from;
  }
  return T;
}

void ck_kr_status(const ck_keyring *kr, const uint8_t pub[32], const char *eid, uint64_t t, uint32_t role, ck_kr_result *st) {
  memset(st, 0, sizeof *st);
  ck_kr_keyid(pub, st->keyid);
  chain_t c;
  chain_of(kr, st->keyid, 0, &c);
  if (!c.ok) { st->reason = c.reason; return; }
  if (c.rec >= 0) {
    const ck_record *r = &kr->records[c.rec];
    if (strcmp(r->subject, eid)) { st->reason = CK_KR_KEY_NOT_FOR_THIS_NODE; return; }
    if (!(c.roles & role)) { st->reason = CK_KR_KEY_LACKS_ROLE; return; }
    if (!in_window(kr, r, t)) { st->reason = t < r->not_before ? CK_KR_KEY_NOT_YET_VALID : CK_KR_KEY_EXPIRED; return; }
  } else if (!kr->anchors[c.anchor].eid[0] || strcmp(kr->anchors[c.anchor].eid, eid)) {
    st->reason = CK_KR_KEY_NOT_FOR_THIS_NODE; return;
  }
  st->ok = 1;
  uint64_t T = revoked_from(kr, st->keyid, 0);
  if (T != NONE) { st->revoked = 1; st->revoked_from = T; }
}
