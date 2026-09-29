# Ground station custody pilot: 90-day plan

For ground station operators and networks evaluating signed pass records. Everything
runs on the operator's own systems, on data the stations already receive. Nothing
changes on the spacecraft, the radio or the DTN software, and no data leaves the network.

## What the operator provides

- Read access, on one Linux host per station (Node.js 18 or later), to the directory where
  received products land (HDTN `BpReceiveFile`, ION `bpcp`, or any file drop).
- The pass schedule as an export: pass id, start and end (ISO time or epoch ms).
- If the ground software logs true reception times, that log (otherwise file times are used).
- One engineer contact, a few hours in weeks 1 and 2.

## Plan

| Weeks | Step | Result |
|---|---|---|
| 1 to 2 | Install the sidecar on one station against recorded passes; generate the station key; pin its public key in the verifier | First signed ledger; every past pass reported, silent passes as gap records |
| 3 to 8 | Run on live passes; add a second station that sees the same spacecraft | Daily ledgers from both stations; cross-station corroboration report |
| 9 to 10 | Tamper and dispute drills: alter a stored product, drop a record, replay a pass report | Each is detected, with the reason, by the operator's own verifier |
| 11 to 12 | Findings report | Passes and products covered, silent passes documented, corroboration rate, measured overhead on the operator's hardware, and a go or no-go for production |

## Success criteria

- 100% of scheduled passes in the pilot window have a signed report, including silent ones.
- Every drill in weeks 9 and 10 is detected by verification with no false alarms on
  unaltered data.
- Any product received by both stations is corroborated.
- Sidecar overhead is measured on the operator's hardware and agreed acceptable.

## What the pilot does not do

It does not prove what the spacecraft sent: that needs a manifest signed on board
(`flight/`, or the NASA cFS app in `flight/cfs/`). It does not move money, and it does
not require any record to leave the operator's network. Publishing the ledger's single
32-byte seal as a public timestamp is optional.

Commands: see [README.md](README.md). Contact: support@embryospace.com.
