/* Onboard offline key management: the rules of spec/KEY-RECORDS.md in C, so a spacecraft
 * can decide by itself whether a key may sign for a node at a given time, including keys
 * and revocations that arrived inside bundles (Key Record Block, type 225).
 *
 * No heap: a keyring is one fixed-size struct (16,856 bytes on ARM Cortex-M4 with the defaults below). Ed25519
 * from TweetNaCl, SHA-256 from sha256.c. Records are kept as received and checked when a key
 * is looked up, so they may arrive in any order. Not reentrant (one static verify buffer). */
#ifndef CK_KEYRING_H
#define CK_KEYRING_H
#include <stddef.h>
#include <stdint.h>

#define CK_KR_MAX_RECORDS 32
#define CK_KR_MAX_ANCHORS 4
#define CK_KR_MAX_PAYLOAD 256   /* record payload bytes (CBOR map) */
#define CK_KR_MAX_EID     64    /* subject EID, including the terminating NUL */

#define CK_ROLE_CUSTODY 1u
#define CK_ROLE_ISSUE   2u
#define CK_ROLE_REVOKE  4u

/* Reasons, the same names as transport/bpv7/keyring.mjs (ck_kr_reason gives the string). */
enum {
  CK_KR_OK = 0, CK_KR_KEY_UNKNOWN, CK_KR_CHAIN_NOT_ANCHORED, CK_KR_CHAIN_TOO_LONG,
  CK_KR_ISSUER_LACKS_ISSUE_ROLE, CK_KR_RECORD_SIGNATURE_INVALID, CK_KR_ISSUER_NOT_VALID_AT_ISSUANCE,
  CK_KR_ISSUER_REVOKED, CK_KR_KEY_NOT_FOR_THIS_NODE, CK_KR_KEY_LACKS_ROLE, CK_KR_KEY_EXPIRED,
  CK_KR_KEY_NOT_YET_VALID
};

typedef struct {
  uint8_t kind;                 /* 1 key record, 2 revocation */
  uint8_t alg_ok;               /* protected header is {1: -8} */
  uint8_t sig[64];
  uint8_t payload[CK_KR_MAX_PAYLOAD];
  uint16_t plen;
  char subject[CK_KR_MAX_EID];
  uint8_t pub[32], keyid[16];   /* key records */
  uint32_t roles;
  uint64_t not_before, not_after, issued_at, effective_from, seen_at;
  uint8_t issuer[16], target[16];
} ck_record;

typedef struct { uint8_t pub[32], id[16]; char eid[CK_KR_MAX_EID]; } ck_anchor;

typedef struct {
  ck_anchor anchors[CK_KR_MAX_ANCHORS]; size_t n_anchors;
  ck_record records[CK_KR_MAX_RECORDS]; size_t n_records;
  uint64_t skew_ms;
} ck_keyring;

typedef struct { int ok; int reason; int revoked; uint64_t revoked_from; uint8_t keyid[16]; } ck_kr_result;

void ck_kr_init(ck_keyring *kr, uint64_t skew_ms);
/* An operator root key (raw 32-byte Ed25519), held out of band; eid may be "" or NULL. */
int ck_kr_anchor(ck_keyring *kr, const uint8_t pub[32], const char *eid);
/* Add one record (an encoded COSE_Sign1) seen at local time seen_at (DTN ms).
 * 1 added, 0 duplicate (its earliest sighting is kept), negative CK_E_* on error. */
int ck_kr_add(ck_keyring *kr, const uint8_t *item, size_t n, uint64_t seen_at);
/* Add every record of a Key Record Block's data (a CBOR array of COSE_Sign1). Returns the
 * number added, or a negative CK_E_* code. */
int ck_kr_ingest_block(ck_keyring *kr, const uint8_t *data, size_t n, uint64_t seen_at);
/* May `pub` sign in `role` for `eid` at time t? Fills st; st->revoked with revoked_from
 * when a revocation applies (the caller then requires a witness before revoked_from). */
void ck_kr_status(const ck_keyring *kr, const uint8_t pub[32], const char *eid, uint64_t t, uint32_t role, ck_kr_result *st);
const char *ck_kr_reason(int reason);
void ck_kr_keyid(const uint8_t pub[32], uint8_t id[16]);

#endif
