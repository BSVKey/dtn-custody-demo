# NASA HDTN LTP under stress: results

Run 2026-10-22 on HDTN 7fbe90c. Reproduce: `make hdtn-ltp-sweep` (Docker; `hdtn/ltp-sweep.sh`).

The same kind of sweep found a bug in JPL ION's LTP receiver that lost every segment after the
first (`voyager/ION-RESULTS.md`, reported as nasa-jpl/ION-DTN#131). This runs it against HDTN's
own LTP: `bpsendfile` (LTP outduct) to `bpreceivefile` (LTP induct) in two network namespaces
joined by a veth pair under netem (delay, loss and bit corruption in both directions). Each case
sends one file of random bytes as one bundle and one LTP block, and passes only when the received
file's SHA-256 matches.

| Sweep | Cases | Passed |
|---|---|---|
| Data segment MTU 64, 200, 550, 1,000, 1,360, 8,000, 60,000 x files of 100 B, 1.5 KB, 20 KB, 300 KB, 3 MB, clean link | 35 | 35 |
| MTU 200, 1,360, 8,000 x 1.5 KB and 300 KB x (5% loss; 20% loss; 1% corruption; 300 ms delay, 5% loss; 2 s delay, 10% loss) | 30 | 30 |
| Edge cases: empty file; 1, 63, 64, 65 bytes at MTU 64; MTU 30; a checkpoint every 10th segment; 40% loss | 11 | 10 |

The one failure is expected: 300 KB at 40% loss in both directions. A checkpoint and its report
both get through only about 36% of the time, so the session reaches its retry limit
(`ltpMaxRetriesPerSerialNumber` 5) and is cancelled, as LTP specifies. The same loss with a
1.5 KB file passed. The sweep turns HDTN's link ping off, so after that cancellation the sender
waits for a link-up that never comes; that is configuration, not a fault.

Slowest passing case: 300 KB over 8,000-byte segments (IP-fragmented into about six packets
each) at 2 s delay and 10% loss, 46 s; with 1,360-byte segments, 12 s.

No HDTN fault found. Limits: one block per case, one sender and one receiver, a 1 s delay
setting unless stated, and no rate limit.
