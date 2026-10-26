# IP <-> DTN gateway

Moves data between an always-on IP link and a delay/disruption-tolerant (DTN) network.

A spacecraft or ground system on an IP link, such as a commercial LEO broadband or optical
relay network, sends plain UDP datagrams or HTTP POSTs. The gateway wraps each one in a
BPv7 bundle (RFC 9171), keeps it on disk, and forwards it over TCPCLv4 (RFC 9174) to a DTN
node such as NASA HDTN. In the other direction it accepts TCPCLv4 sessions from DTN nodes
and hands each bundle addressed to it to a local UDP endpoint. Nothing on the IP side
needs to know about bundles, and nothing on the DTN side needs to know about IP.

```
app --UDP/HTTP--> gateway A (ipn:1) --TCPCLv4--> DTN network --TCPCLv4--> gateway B (ipn:2) --UDP--> app
```

## Why a gateway

IP links in low Earth orbit hand off between satellites and ground stations, and a
spacecraft can lose its IP path for seconds to minutes. DTN networks (NASA's Near Space and
Deep Space Networks run DTN as an operational service) are built for exactly that. The
gateway lets IP-native equipment use them without a DTN stack of its own:

- **Store and forward on the IP side.** Every bundle is written to disk before it is sent
  and deleted only after the DTN peer acknowledges every byte. A dropped link or a
  restarted gateway resends what was waiting, in order.
- **Standard protocols only.** BPv7 bundles over TCPCLv4, so any compliant DTN node can be
  the peer. Tested against NASA HDTN.
- **Optional ingress receipt** (block type 226). The gateway signs which exact bytes it
  took from which IP source and when. The far gateway, or anyone with the gateway's public
  key, can check that the payload was not changed in the DTN network. Nodes that do not
  know the block forward it unchanged.

## Run

```
node gateway/cli.mjs gateway.json
```

See the header of `cli.mjs` for every config field. A minimal pair:

```json
{ "node": 1, "peer": { "host": "dtn-node", "port": 4556 },
  "ipIngress": { "udp": [{ "port": 9100, "dest": "ipn:2.1" }] }, "keyFile": "gw-a.key.json" }
```
```json
{ "node": 2, "listenPort": 4558, "ipEgress": { "1": { "udp": "127.0.0.1:9101" } },
  "pinnedGateways": { "ipn:1.0": "<gateway A public key>" }, "requireIngressReceipt": true }
```

## Tests

- `node --test test/gateway.test.mjs`: TCPCLv4 handshake, segmentation to the peer's
  limit, cumulative acks, version refusal, oversized segments, receipts and tampering,
  a gateway pair end to end, a link outage plus a gateway restart, and HTTP ingress.
- With NASA HDTN (`hdtn/Dockerfile` image):
  `docker run --rm -v "$PWD:/app" -w /app dtn-custody-hdtn node gateway/hdtn-interop.mjs`.
  Results in [RESULTS.md](RESULTS.md).

## Limits

- No TLS on TCPCLv4 yet (CAN_TLS is not offered). Run it inside a trusted network or a VPN.
- Only `ipn` endpoint IDs. One bundle per datagram or POST; no bundle fragmentation.
- Tested against HDTN. JPL ION's TCP convergence layer (`bpv7/tcp`) follows RFC 7242,
  TCPCL version 3, so reaching ION needs a TCPCLv4-capable node such as HDTN in between.
- It has not been run over any operator's satellite network. The IP side is ordinary
  UDP/HTTP, and the outages in the tests are simulated by stopping the DTN node.
