# Gateway interop results

Each run: 10 frames with everything up, then the DTN node is killed (the relay link is
gone), 10 more frames are sent while it is down, and the node is started again. Every frame
must arrive exactly once, in order, with a valid signed ingress receipt from gateway A.

| DTN node | Link | Result |
|---|---|---|
| NASA HDTN `7fbe90c` (stock config) | TCPCLv4 (RFC 9174) | 20/20 in order, 10 held on disk during the outage, 20/20 receipts valid |
| NASA HDTN `7fbe90c` | TCPCLv4 over TLS 1.3, both hops | 20/20 in order, 10 held on disk, 20/20 receipts valid; HDTN verified gateway B's Node ID in its certificate |
| JPL ION `c5a4d87` (contact graph routing) | TCPCLv3 (RFC 7242) | 20/20 in order, 10 held on disk, 20/20 receipts valid |

Run them:

```
docker run --rm -v "$PWD:/app" -w /app dtn-custody-hdtn node gateway/hdtn-interop.mjs
docker run --rm -v "$PWD:/app" -w /app dtn-custody-hdtn node gateway/hdtn-interop.mjs --tls
docker run --rm --privileged -v "$PWD:/app" -w /app dtn-custody-ion node gateway/ion-interop.mjs
```

## TLS details

- Certificates name each node the RFC 9174 way: a subjectAltName otherName of type
  id-on-bundleEID (1.3.6.1.5.5.7.8.11). `gateway/certs.mjs` makes a test CA and these.
- Gateway A -> HDTN: CA-signed certificates; gateway A checked that HDTN's certificate names
  `ipn:10.0`.
- HDTN -> gateway B: HDTN's TCPCLv4 outduct at `7fbe90c` checks the Node ID on every
  certificate in the chain, the CA included, so a CA-signed chain fails ("the subjectAltName
  URI in the X.509 certificate does not match the next hop endpoint id of ipn:2.0" against
  the CA certificate). The check belongs on the end-entity certificate only. This hop
  therefore pins gateway B's self-signed certificate, the same form as HDTN's shipped TLS
  configs.

## Output

```
GATEWAY_HDTN_RESULT {"ok":true,"hdtnCommit":"7fbe90c","path":"UDP -> gateway A ipn:1 -TCPCLv4-> NASA HDTN ipn:10 -TCPCLv4-> gateway B ipn:2 -> UDP","delivered":20,"expected":20,"inOrder":true,"ingressReceiptsValid":20,"spooledDuringOutage":10}
GATEWAY_HDTN_RESULT {"ok":true,"hdtnCommit":"7fbe90c","path":"UDP -> gateway A ipn:1 -TCPCLv4+TLS-> NASA HDTN ipn:10 -TCPCLv4+TLS-> gateway B ipn:2 -> UDP","tls":true,"gatewayAPeerTls":true,"delivered":20,"expected":20,"inOrder":true,"ingressReceiptsValid":20,"spooledDuringOutage":10,"tlsSessionsIntoB":2}
GATEWAY_ION_RESULT {"ok":true,"ionCommit":"c5a4d87","path":"UDP -> gateway A ipn:1 -TCPCLv3-> JPL ION ipn:10 -TCPCLv3-> gateway B ipn:2 -> UDP","delivered":20,"expected":20,"inOrder":true,"ingressReceiptsValid":20,"spooledDuringOutage":10}
```
