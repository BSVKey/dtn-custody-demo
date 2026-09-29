/* CUSTODY cFS application. See custody_app.h.
 *
 * Startup: register events, run a self-test that signs the published test-vector
 * custody record with the published test key and compares the claim id and signature,
 * then load the vehicle's signing seed from CUSTODY_KEY_FILE.
 * Commands: NOOP, and SIGN, which signs one custody/1 receipt with the vehicle key and
 * writes the canonical JSON record to /cf for downlink. */
#include "custody_app.h"
#include "custody.h"
#include <string.h>
#include <stdio.h>

static struct {
  CFE_SB_PipeId_t Pipe;
  uint32          RunStatus;
  ck_key          Key;
  bool            KeyLoaded;
  bool            SelfTestPassed;
  uint32          Signed;
  uint32          Errors;
} C;

/* Published test vector (spec/test-vectors.json): relay seed 0x02 x 32. */
#define VEC_CLAIM "0x7fee5ec33f2b8bbee4f71110073c87809aed7e177fb494774b9a44d56b030fdb"
#define VEC_SIG   "ct0UFZ+iRJCGI6ME3l3BH3BjEkGcTHRPC9nBACLWZZ6p8GEqq4PX8siCpBHfUjPOT63jD1oeU8GMk1/D+gY6DA=="
#define VEC_BID   "0x7ab0bc0e11b2448037d4653a64d8319f8c3f018af7bf2695a9933bfa28242785"

static void SelfTest(void) {
  uint8 seed[32];
  ck_key k;
  char rec[1024];
  memset(seed, 0x02, sizeof seed);
  C.SelfTestPassed = ck_key_from_seed(&k, seed) == 0 &&
    ck_custody(&k, "0xvector-001", VEC_BID, "dtn://source/", "dtn://relaya/", 1000, 1050, rec, sizeof rec) == 0 &&
    strstr(rec, "\"claimId\":\"" VEC_CLAIM "\"") != NULL && strstr(rec, "\"sig\":\"" VEC_SIG "\"") != NULL;
  memset(&k, 0, sizeof k);
  CFE_EVS_SendEvent(CUSTODY_SELFTEST_EID, C.SelfTestPassed ? CFE_EVS_EventType_INFORMATION : CFE_EVS_EventType_CRITICAL,
                    "CUSTODY self-test %s: test-vector claim id and signature %s", C.SelfTestPassed ? "PASS" : "FAIL",
                    C.SelfTestPassed ? "reproduced" : "MISMATCH");
}

static void LoadKey(void) {
  osal_id_t fd;
  uint8 seed[32];
  C.KeyLoaded = false;
  if (OS_OpenCreate(&fd, CUSTODY_KEY_FILE, OS_FILE_FLAG_NONE, OS_READ_ONLY) != OS_SUCCESS) {
    CFE_EVS_SendEvent(CUSTODY_KEY_EID, CFE_EVS_EventType_ERROR, "CUSTODY no signing key at %s; signing disabled", CUSTODY_KEY_FILE);
    return;
  }
  int32 n = OS_read(fd, seed, sizeof seed);
  OS_close(fd);
  if (n == (int32)sizeof seed && ck_key_from_seed(&C.Key, seed) == 0) {
    C.KeyLoaded = true;
    CFE_EVS_SendEvent(CUSTODY_KEY_EID, CFE_EVS_EventType_INFORMATION, "CUSTODY signing key loaded, pub %.60s", C.Key.pub_b64);
  } else {
    CFE_EVS_SendEvent(CUSTODY_KEY_EID, CFE_EVS_EventType_ERROR, "CUSTODY key file unreadable (%d bytes); signing disabled", (int)n);
  }
  memset(seed, 0, sizeof seed);
}

/* Copy a fixed-size command string, requiring NUL termination inside the field. */
static bool Str(char *dst, const char *src, size_t n) {
  if (memchr(src, 0, n) == NULL) return false;
  memcpy(dst, src, n);
  return true;
}

static void Sign(const CFE_SB_Buffer_t *Buf, CFE_MSG_Size_t Size) {
  const CUSTODY_SignCmd_t *Cmd = (const CUSTODY_SignCmd_t *)Buf;
  CUSTODY_SignPayload_t P;
  char rec[1024], path[64];
  osal_id_t fd;
  int rc;

  if (Size != sizeof(CUSTODY_SignCmd_t)) {
    C.Errors++;
    CFE_EVS_SendEvent(CUSTODY_ERR_EID, CFE_EVS_EventType_ERROR, "CUSTODY sign: bad length %u, expected %u", (unsigned)Size, (unsigned)sizeof(CUSTODY_SignCmd_t));
    return;
  }
  if (!C.KeyLoaded || !C.SelfTestPassed) {
    C.Errors++;
    CFE_EVS_SendEvent(CUSTODY_ERR_EID, CFE_EVS_EventType_ERROR, "CUSTODY sign refused: %s", C.SelfTestPassed ? "no key" : "self-test failed");
    return;
  }
  memcpy(&P.ReceivedAt, &Cmd->Payload.ReceivedAt, sizeof P.ReceivedAt);
  memcpy(&P.ForwardedAt, &Cmd->Payload.ForwardedAt, sizeof P.ForwardedAt);
  if (!Str(P.PayloadId, Cmd->Payload.PayloadId, sizeof P.PayloadId) || !Str(P.BundleId, Cmd->Payload.BundleId, sizeof P.BundleId) ||
      !Str(P.PrevHop, Cmd->Payload.PrevHop, sizeof P.PrevHop) || !Str(P.ThisHop, Cmd->Payload.ThisHop, sizeof P.ThisHop)) {
    C.Errors++;
    CFE_EVS_SendEvent(CUSTODY_ERR_EID, CFE_EVS_EventType_ERROR, "CUSTODY sign: unterminated string field");
    return;
  }
  rc = ck_custody(&C.Key, P.PayloadId, P.BundleId, P.PrevHop, P.ThisHop, P.ReceivedAt, P.ForwardedAt, rec, sizeof rec);
  if (rc != 0) {
    C.Errors++;
    CFE_EVS_SendEvent(CUSTODY_ERR_EID, CFE_EVS_EventType_ERROR, "CUSTODY sign: record refused (code %d)", rc);
    return;
  }
  snprintf(path, sizeof path, CUSTODY_OUT_FMT, (unsigned)(C.Signed + 1));
  if (OS_OpenCreate(&fd, path, OS_FILE_FLAG_CREATE | OS_FILE_FLAG_TRUNCATE, OS_WRITE_ONLY) != OS_SUCCESS) {
    C.Errors++;
    CFE_EVS_SendEvent(CUSTODY_ERR_EID, CFE_EVS_EventType_ERROR, "CUSTODY cannot write %s", path);
    return;
  }
  OS_write(fd, rec, strlen(rec));
  OS_close(fd);
  C.Signed++;
  const char *id = strstr(rec, "\"claimId\":\"");
  CFE_EVS_SendEvent(CUSTODY_SIGNED_EID, CFE_EVS_EventType_INFORMATION, "CUSTODY receipt %u signed to %s, claimId %.18s...",
                    (unsigned)C.Signed, path, id ? id + 11 : "?");
}

void CUSTODY_AppMain(void) {
  CFE_SB_Buffer_t *Buf;
  CFE_SB_MsgId_t   MsgId;
  CFE_MSG_FcnCode_t Fc;
  CFE_MSG_Size_t   Size;

  memset(&C, 0, sizeof C);
  C.RunStatus = CFE_ES_RunStatus_APP_RUN;
  CFE_EVS_Register(NULL, 0, CFE_EVS_EventFilter_BINARY);
  if (CFE_SB_CreatePipe(&C.Pipe, 16, "CUSTODY_CMD") != CFE_SUCCESS ||
      CFE_SB_Subscribe(CFE_SB_ValueToMsgId(CUSTODY_CMD_MID), C.Pipe) != CFE_SUCCESS) {
    C.RunStatus = CFE_ES_RunStatus_APP_ERROR;
  }
  CFE_EVS_SendEvent(CUSTODY_INIT_EID, CFE_EVS_EventType_INFORMATION, "CUSTODY app initialized, command MID 0x%04X", CUSTODY_CMD_MID);
  SelfTest();
  LoadKey();

  while (CFE_ES_RunLoop(&C.RunStatus)) {
    if (CFE_SB_ReceiveBuffer(&Buf, C.Pipe, CFE_SB_PEND_FOREVER) != CFE_SUCCESS) continue;
    CFE_MSG_GetMsgId(&Buf->Msg, &MsgId);
    CFE_MSG_GetFcnCode(&Buf->Msg, &Fc);
    CFE_MSG_GetSize(&Buf->Msg, &Size);
    if (!CFE_SB_MsgId_Equal(MsgId, CFE_SB_ValueToMsgId(CUSTODY_CMD_MID))) continue;
    if (Fc == CUSTODY_SIGN_CC) Sign(Buf, Size);
    else if (Fc == CUSTODY_NOOP_CC) CFE_EVS_SendEvent(CUSTODY_NOOP_EID, CFE_EVS_EventType_INFORMATION, "CUSTODY NOOP: %u signed, %u errors", (unsigned)C.Signed, (unsigned)C.Errors);
    else { C.Errors++; CFE_EVS_SendEvent(CUSTODY_ERR_EID, CFE_EVS_EventType_ERROR, "CUSTODY unknown command code %u", (unsigned)Fc); }
  }
  memset(&C.Key, 0, sizeof C.Key);
  CFE_ES_ExitApp(C.RunStatus);
}
