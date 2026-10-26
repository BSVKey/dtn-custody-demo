# IP <-> DTN gateway

Moves data between an always-on IP link and a delay/disruption-tolerant (DTN) network.

A spacecraft or ground system on an IP link, such as a commercial LEO broadband or optical
relay network, sends plain UDP datagrams or HTTP POSTs. The gateway wraps each one in a
BPv7 bundle (RFC 9171), keeps it on disk, and forwards it to a DTN node over TCPCLv4
(RFC 9174, optionally over TLS) or TCPCLv3 (RFC 7242). In the other direction it accepts
sessions from DTN nodes and hands each bundle addressed to it to a local UDP endpoint.
Nothing on the IP side needs to know about bundles, and nothing on the DTN side needs to
know about IP.

```
app --UDP/HTTP--> gateway A --TCPCL--> DTN network --TCPCL--> gateway B --UDP--> app
```

## What it does

- **Store and forward on the IP side.** Every bundle is written to disk before it is sent
  and deleted only after the DTN peer acknowledges every byte. A dropped link or a
  restarted gateway resends what was waiting, in order.
- **Standard protocols only.** BPv7 bundles over TCPCLv4 (NASA HDTN, dtn7, Hardy) or
  TCPCLv3 (JPL ION), chosen per link. Tested against HDTN and ION.
- **Large messages.** Payloads above `maxBundlePayload` (1 MB by default) go as BPv7
  fragments and are reassembled at the far gateway in any order.
- **`ipn` and `dtn` addresses.** A gateway is `ipn:N.0` or `dtn://name/`.
- **Optional ingress receipt** (block type 226). The gateway signs which exact bytes it
  took from which IP source and when. The far gateway, or anyone with the gateway's public
  key, can check that the payload was not changed in the DTN network. Nodes that do not
  know the block forward it unchanged.

## Keeping it off the open internet

A gateway accepts traffic and forwards it into a DTN network, so treat it like any relay:

1. **Local by default.** The DTN listener and HTTP ingress bind to 127.0.0.1 unless you set
   `listenHost` / `http.host`. UDP ingress binds to 127.0.0.1 unless you set its `host`.
2. **Encrypt and authenticate the DTN link.** Set `tls` with `key`, `cert` and `ca`,
   `require: true` and `verifyNodeId: true`. Both ends must then present a certificate from
   your CA that names their Node ID (RFC 9174 id-on-bundleEID), so nobody can read the
   traffic, and no node can pose as another. `gateway/certs.mjs` makes test certificates.
3. **Say who may connect.** `allowedPeers` (Node IDs) and `allowedIps` (addresses) refuse
   everyone else; with `allowedIps` the connection is dropped before a byte is read.
4. **Lock the IP side.** `http.token` requires `Authorization: Bearer <token>`,
   `http.maxBytes` caps uploads, and `udp[].allowedSources` limits who may send datagrams.
5. **Put it behind a firewall or VPN** (WireGuard, Tailscale, IPsec) when the peer is far
   away, and open the TCPCL port only to the peer's address.
6. **TCPCLv3 has no TLS.** A gateway with `tls.require` refuses to use it; for an ION peer,
   keep that link inside a VPN or a private network.

## Run

```
node gateway/cli.mjs gateway.json
```

See the header of `cli.mjs` for every config field. A TLS pair:

```json
{ "node": 1, "peer": { "host": "dtn-node.example", "port": 4556 },
  "tls": { "keyFile": "ipn_1.0.key", "certFile": "ipn_1.0.crt", "caFile": "ca.crt", "require": true, "verifyNodeId": true },
  "ipIngress": { "udp": [{ "port": 9100, "dest": "ipn:2.1" }] }, "keyFile": "gw-a.key.json" }
```
```json
{ "node": 2, "listenPort": 4558, "allowedPeers": ["ipn:10.0"],
  "tls": { "keyFile": "ipn_2.0.key", "certFile": "ipn_2.0.crt", "caFile": "ca.crt", "require": true, "verifyNodeId": true },
  "ipEgress": { "1": { "udp": "127.0.0.1:9101" } },
  "pinnedGateways": { "ipn:1.0": "<gateway A public key>" }, "requireIngressReceipt": true }
```

For a JPL ION peer, add `"cl": "tcpclv3"` to `peer` (or `"listenCl": "tcpclv3"`).

## Tests

- `node --test test/gateway*.test.mjs`: TCPCLv4 and v3 sessions, TLS (mutual certificates,
  impersonation, a foreign CA, TLS required, a recording proxy showing the payload is plain
  without TLS and absent with it), allowlists, fragmentation and reassembly, `dtn` addresses,
  receipts and tampering, outages with restarts, and HTTP limits.
- Against real DTN nodes: see [RESULTS.md](RESULTS.md) for NASA HDTN (with and without
  TLS) and JPL ION.

## Limits

- Not yet run over any operator's satellite network. The outages in the tests are
  simulated by stopping the DTN node.
- HDTN's TCPCLv4 outduct (commit `7fbe90c`) checks the Node ID on every certificate in the
  chain, so towards a gateway it needs a self-signed certificate rather than a CA chain.
  Details in [RESULTS.md](RESULTS.md).
- One DTN peer per gateway for sending; run several gateways for several next hops.
