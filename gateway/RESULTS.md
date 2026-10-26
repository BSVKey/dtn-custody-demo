# Gateway with NASA HDTN

Run on 2026-10-26 with `gateway/hdtn-interop.mjs` inside the `hdtn/Dockerfile` image.

- NASA HDTN commit `7fbe90c`, `hdtn-one-process` with its stock config
  `hdtn_ingress1tcpclv4_port4556_egress1tcpclv4_port4558flowid2.json`.
- Path: UDP -> gateway A (`ipn:1`) -TCPCLv4-> HDTN (`ipn:10`) -TCPCLv4-> gateway B (`ipn:2`) -> UDP.

| Phase | What happened | Result |
|---|---|---|
| 1 | 10 frames sent with everything up | 10/10 delivered |
| 2 | HDTN stopped (relay link gone); 10 more frames sent | gateway A held 10 bundles on disk |
| 2 | HDTN restarted | all 20 frames delivered once, in order |
| | Ingress receipts checked at gateway B against gateway A's pinned key | 20/20 valid |

```
GATEWAY_HDTN_RESULT {"ok":true,"hdtnCommit":"7fbe90c","path":"UDP -> gateway A ipn:1 -TCPCLv4-> NASA HDTN ipn:10 -TCPCLv4-> gateway B ipn:2 -> UDP","delivered":20,"expected":20,"inOrder":true,"ingressReceiptsValid":20,"spooledDuringOutage":10,"gatewayA":{"fromIp":20,"toDtn":20,"fromDtn":0,"toIp":0,"rejected":0},"gatewayB":{"fromIp":0,"toDtn":0,"fromDtn":20,"toIp":20,"rejected":0}}
```
