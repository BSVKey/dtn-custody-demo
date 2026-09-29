# hdtn/: custody payload through NASA HDTN

Status: **run and passed** (2026-09-29, NASA HDTN commit 7fbe90c). See [RESULTS.md](RESULTS.md).

What it does: builds NASA HDTN (High-rate DTN, NASA Glenn) from source, compiles
`interop.json` with `contact-plans/compile.mjs` into HDTN's contact-plan format, and sends
our custody payload (signed manifest plus Merkle-committed chunks with sender custody
receipts) from HDTN's BpSendFile (ipn:1.1) through the HDTN router (ipn:10) to
BpReceiveFile (ipn:2.1). The router-to-receiver link is scheduled down from 15 s to 35 s and
the payload is sent at about 18 s, so HDTN must store it and forward it when the contact
opens. `verify.mjs` checks the manifest, every chunk, the custody handoffs and the timing
against the schedule, and prints `HDTN_RESULT`.

Boundary: HDTN's router has no hook for our agent, so the HDTN hop does not sign a custody
receipt; custody is signed at the sender and verified end to end at the receiver.

```bash
docker build -t dtn-custody-hdtn -f hdtn/Dockerfile .
docker run --rm dtn-custody-hdtn
```

The C++ build is large; give Docker at least 8 GB of memory.
