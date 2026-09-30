/* Onboard custody records in C: the same bytes as the reference implementation
 * (spec/CUSTODY-RECORDS.md), for flight processors. No heap, no OS services beyond
 * what the caller provides; Ed25519 from TweetNaCl (public domain).
 *
 * Every function returns 0 on success and a negative CK_E* code on failure. Strings in
 * records are restricted to printable ASCII without '"' or '\\', so canonical JSON needs
 * no escaping and a hostile string can never change a record's structure. */
#ifndef CK_CUSTODY_H
#define CK_CUSTODY_H
#include <stddef.h>
#include <stdint.h>

#define CK_E_STRING  -1  /* string outside the allowed character set */
#define CK_E_NUMBER  -2  /* integer outside 0 .. 2^53-1 */
#define CK_E_SPACE   -3  /* output buffer too small */
#define CK_E_ARG     -4  /* bad argument */

#define CK_ID_LEN   66   /* "0x" + 64 hex */
#define CK_SIG_B64  88   /* base64 of a 64-byte signature */
#define CK_PUB_B64  60   /* base64 of the 44-byte Ed25519 SubjectPublicKeyInfo */

typedef struct { uint8_t pk[32]; uint8_t sk[64]; char pub_b64[CK_PUB_B64 + 1]; } ck_key;

/* Load a signing key from its 32-byte seed (read from protected storage by the caller). */
int ck_key_from_seed(ck_key *k, const uint8_t seed[32]);

/* Merkle primitives: leaf = SHA-256(0x00 || bytes), node = SHA-256(0x01 || left || right). */
void ck_leaf(const uint8_t *bytes, size_t n, uint8_t out[32]);
void ck_node(const uint8_t l[32], const uint8_t r[32], uint8_t out[32]);
/* Root over fixed-size chunks of a payload; `scratch` holds one hash per chunk (32 bytes each). */
int ck_root(const uint8_t *payload, size_t n, size_t chunk, uint8_t (*scratch)[32], size_t max_leaves, uint8_t root[32], size_t *count);

/* Content id of a chunk: bundleId = contentId({payloadId, index, leafHex}). */
int ck_bundle_id(const char *payload_id, uint64_t index, const uint8_t leaf[32], char out[CK_ID_LEN + 1]);

/* Signed records, written as canonical JSON of the full record (content + claimId,
 * sig, signerPub) into `out`. */
int ck_manifest(const ck_key *k, const char *payload_id, uint64_t chunk_count, const uint8_t root[32], uint64_t chunk_size, char *out, size_t cap);
int ck_custody(const ck_key *k, const char *payload_id, const char *bundle_id, const char *prev_hop, const char *this_hop,
               uint64_t received_at, uint64_t forwarded_at, char *out, size_t cap);

/* One signed custody-batch/1 record for a contact: the bundle ids taken from prev_hop in
 * [from, to]. `ids` is sorted and de-duplicated in place (it is an array of pointers);
 * `scratch` holds one 32-byte hash per id. */
int ck_batch(const ck_key *k, const char *prev_hop, const char *this_hop, const char *contact_id,
             uint64_t from, uint64_t to, const char **ids, size_t n_ids, uint8_t (*scratch)[32], char *out, size_t cap);

void ck_hex(const uint8_t *b, size_t n, char *out); /* lowercase, NUL-terminated */

#endif
