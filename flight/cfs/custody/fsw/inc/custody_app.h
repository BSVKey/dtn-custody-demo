/* CUSTODY: a NASA cFS application that signs data-custody receipts on board.
 * Records are byte-identical to the open reference implementation
 * (spec/CUSTODY-RECORDS.md), so the ground verifies them with the same code. */
#ifndef CUSTODY_APP_H
#define CUSTODY_APP_H
#include "cfe.h"

#define CUSTODY_CMD_MID        0x18F0   /* ground command MID */
#define CUSTODY_NOOP_CC        0
#define CUSTODY_SIGN_CC        1        /* sign one custody/1 receipt */

#define CUSTODY_KEY_FILE       "/cf/custody_key.bin"   /* 32-byte Ed25519 seed */
#define CUSTODY_OUT_FMT        "/cf/custody_%04u.json" /* one signed record per file */

/* Event IDs */
#define CUSTODY_INIT_EID       1
#define CUSTODY_SELFTEST_EID   2
#define CUSTODY_KEY_EID        3
#define CUSTODY_SIGNED_EID     4
#define CUSTODY_ERR_EID        5
#define CUSTODY_NOOP_EID       6

/* Sign command. Strings are NUL-terminated printable ASCII; times are epoch ms. */
typedef struct {
  uint64 ReceivedAt;
  uint64 ForwardedAt;
  char   PayloadId[64];
  char   BundleId[68];
  char   PrevHop[64];
  char   ThisHop[64];
} CUSTODY_SignPayload_t;

typedef struct {
  CFE_MSG_CommandHeader_t CommandHeader;
  CUSTODY_SignPayload_t   Payload;
} CUSTODY_SignCmd_t;

void CUSTODY_AppMain(void);
#endif
