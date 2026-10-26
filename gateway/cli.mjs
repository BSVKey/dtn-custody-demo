#!/usr/bin/env node
// Run one IP <-> DTN gateway from a JSON config:
//
//   node gateway/cli.mjs gateway.json
//
// {
//   "node": 1,                     this gateway's ipn node number (node id ipn:1.0), or
//   "nodeId": "dtn://sat-a/",      a dtn node name instead
//   "spoolDir": "./spool-a",       bundles waiting for the DTN peer
//   "peer": { "host": "dtn-node", "port": 4556, "cl": "tcpclv4" },   next hop; cl "tcpclv3" for JPL ION
//   "listenPort": 4558,            accept sessions from DTN nodes (optional)
//   "listenHost": "127.0.0.1",     address to listen on (default 127.0.0.1)
//   "listenCl": "tcpclv4",         or "tcpclv3"
//   "tls": { "keyFile": "n.key", "certFile": "n.crt", "caFile": "ca.crt",
//            "require": true, "verifyNodeId": true },   TCPCLv4 over TLS (files relative to this config)
//   "allowedPeers": ["ipn:10.0"],  refuse other DTN Node IDs
//   "allowedIps": ["203.0.113.7"], drop connections from other addresses
//   "ipIngress": {
//     "udp": [{ "port": 9100, "dest": "ipn:2.1", "allowedSources": ["127.0.0.1"] }],
//     "http": { "port": 8080, "token": "...", "maxBytes": 67108864 }   POST /bundles?dest=..., GET /status
//   },
//   "ipEgress": { "1": { "udp": "127.0.0.1:9101" } },   deliver service 1 (or a dtn demux) here
//   "maxBundlePayload": 1000000,   larger payloads go as BPv7 fragments
//   "keyFile": "./gateway-a.key.json",   sign ingress receipts (created if missing)
//   "pinnedGateways": { "ipn:1.0": "<base64 public key>" },
//   "requireIngressReceipt": false,
//   "lifetimeMs": 86400000
// }
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { Gateway } from "./gateway.mjs";
import { genKeypair, exportKeypair, importKeypair } from "../agent/lib/keys.mjs";

const file = process.argv[2];
if (!file) { console.error("usage: node gateway/cli.mjs <config.json>"); process.exit(2); }
const cfg = JSON.parse(readFileSync(file, "utf8"));
const base = dirname(resolve(file));
cfg.spoolDir = resolve(base, cfg.spoolDir || `spool-${cfg.node}`);
if (cfg.tls) {
  const t = cfg.tls;
  const load = (f) => (f ? readFileSync(resolve(base, f)) : undefined);
  cfg.tls = { ...t, key: t.key || load(t.keyFile), cert: t.cert || load(t.certFile), ca: t.ca || load(t.caFile) };
  if (t.require && !(cfg.tls.key && cfg.tls.cert)) { console.error("tls.require is set but keyFile/certFile are missing"); process.exit(2); }
}

if (cfg.keyFile) {
  const kf = resolve(base, cfg.keyFile);
  if (!existsSync(kf)) {
    writeFileSync(kf, JSON.stringify(exportKeypair(genKeypair()), null, 2), { mode: 0o600 });
    console.log(`created signing key ${kf}`);
  }
  cfg.keypair = importKeypair(JSON.parse(readFileSync(kf, "utf8")));
  console.log(`ingress receipts signed by ipn:${cfg.node}.0, public key ${cfg.keypair.pub}`);
}

const gw = await new Gateway({ ...cfg, log: (m) => console.log(`[${new Date().toISOString()}] ${m}`) }).start();
console.log(`gateway ipn:${cfg.node}.0 running; ${gw.spool.size} bundle(s) waiting from before`);
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, async () => { await gw.stop(); process.exit(0); });
