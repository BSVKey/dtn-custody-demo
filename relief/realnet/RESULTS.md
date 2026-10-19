# Relief scenario over a real network

Runs 2026-10-19 on an Intel Xeon @ 2.80GHz VM (Linux 6.18), Node v22.22.0, µD3TN built from
source at commit `025e819` (2026-10-15). Reproduce: `sudo UD3TN=/opt/ud3tn bash relief/realnet/run.sh`.
Each run's full result is in [`runs/`](runs/).

## Setup

Five Linux network namespaces, one per device, joined by veth links. Each runs its own µD3TN
(BPv7) and the relief node daemon from [`relief/kit`](../kit/). Nothing is simulated in
software time: the files cross real kernel network links.

```
clinic-north --+  Wi-Fi Direct
clinic-river --+-> courier-07 --ride--> village-kalo ==GEO satellite==> district-hub
```

| Link | Conditions |
|---|---|
| Clinic to courier | 0.5% random packet loss (iptables) |
| Courier to village | the µD3TN contact opens only when the courier arrives (RIDE) |
| Village to hub (satellite) | 280 ms +-20 ms one-way delay, 1% random loss, 512 kbit/s rate limit, and a blackout: 100% packet loss in both directions while the terminal is out of power |

This VM's kernel has no `tc netem`, so loss is iptables random drops, the rate limit is a kernel
`tbf` qdisc, and the delay is a TCP relay that holds every segment in order
([`delay-relay.mjs`](delay-relay.mjs)). On a kernel with netem, `run.sh` uses netem for all of it.

Traffic, all synthetic: two daily clinic reports (399 and 408 bytes, 1 chunk each) and a
48 KB attachment (49 chunks of 1 KB), each sealed to the hub.

## Results

| Run | Link | Courier arrives | Blackout | Verified | Attachment byte-identical | Refused | Duplicates | Total time |
|---|---|---|---|---|---|---|---|---|
| A | TCPCLv3 | +30 s | +20 s to +70 s | 3 of 3 | yes | 0 | 0 | 83 s |
| B | TCPCLv3 | +30 s | +20 s to +70 s | 3 of 3 | yes | 0 | 0 | 84 s |
| C | TCPCLv3 | +45 s | +30 s to +150 s | 3 of 3 | yes | 0 | 0 | 259 s |
| D | mtcp | +30 s | +20 s to +70 s | 3 of 3 | yes | 0 | 0 | 84 s |
| E | mtcp | +30 s | +20 s to +70 s | 3 of 3 | yes | 0 | 0 | 85 s |

Link times the hub measured from the signed custody timestamps (run A, attachment): clinic to
courier 0.0 s, courier to village 23.0 s (waiting for the courier to arrive), village to hub
54.0 s (waiting out the blackout). The hub flagged both waits as holds. Each relay was credited
for all 51 bundles it carried; nothing was refused.

## Findings

1. **Every file came through a real blackout,** verified and byte-identical, in all five runs.
   µD3TN kept the bundles in the village relay's storage while the satellite link dropped every
   packet, and the hub checked every chunk and every custody receipt.
2. **Recovery after a long outage varies.** In run C the 120 s blackout ended at +150 s, but
   delivery came at about +255 s: about 100 s spent re-establishing the connection. An earlier
   run with the same timing recovered in 3 s. A field deployment should expect minutes, not
   seconds, after a long outage.
3. **TCPCLv3 versus mtcp.** Both delivered everything in these runs. TCPCLv3 acknowledges every
   bundle (RFC 7242), so an interrupted transfer is retried, and the kit recommends it. An early
   run in which two chunks never arrived used mtcp, but that run also had two harness bugs, since
   fixed: the delay relay could reorder data by a millisecond, and the µD3TN nodes shared one
   control socket file. These runs do not show that mtcp loses data.
4. **Raw-byte sealing saves satellite bandwidth.** Sealing files as raw bytes instead of base64
   cut the attachment from 65 chunks to 49.

## What this does not show

- Real radios, real distances or real power cuts: the links are Linux kernel links with real
  loss, rate limits, delay and blackouts, all on one machine.
- Long runs, many devices, or devices that restart mid-transfer (the hub's restart from its
  frame log is covered by the kit's tests).
- Real BSV payouts. The payouts are computed; `relief/kit/payout.mjs` builds and broadcasts
  them with the operator's own wallet, which this environment could not reach.
