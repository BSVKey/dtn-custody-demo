#!/usr/bin/env node
// Provision a relief deployment: one signing key per node, the hub's encryption key, a
// private config file per device and a public directory.
//
//   node relief/kit/provision.mjs relief/kit/deployment.example.json --out deploy/
//
// Each <node>.json holds that node's PRIVATE signing key (and, for the hub, the private
// decryption key): copy it to that one device only, over a channel you trust, before the
// device goes to the field. directory.json is public: every node id, role, public key and
// relay payout address. The tool refuses to overwrite an existing deployment, because
// regenerating keys would orphan devices already in the field.
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { genKeypair, exportKeypair } from "../../agent/lib/keys.mjs";
import { genEncKeypair } from "./lib/seal.mjs";

const ROLES = new Set(["clinic", "relay", "hub"]);

export function provision(deployment) {
  const nodes = deployment.nodes || [];
  const hubs = nodes.filter((n) => n.role === "hub");
  if (hubs.length !== 1) throw new Error("deployment needs exactly one hub");
  const names = new Set(), eids = new Set();
  for (const n of nodes) {
    if (!ROLES.has(n.role)) throw new Error(`${n.name}: role must be clinic, relay or hub`);
    if (!/^[a-z0-9][a-z0-9-]*$/.test(n.name || "")) throw new Error(`bad node name ${n.name}`);
    if (!/^dtn:\/\/[a-z0-9.-]+\/$/.test(n.eid || "")) throw new Error(`${n.name}: eid must look like dtn://name.dtn/`);
    if (names.has(n.name) || eids.has(n.eid)) throw new Error(`duplicate node ${n.name} / ${n.eid}`);
    names.add(n.name); eids.add(n.eid);
    if (n.role !== "hub" && !nodes.some((m) => m.eid === n.next)) throw new Error(`${n.name}: next hop ${n.next} is not a node in this deployment`);
  }
  const hub = hubs[0];
  const sign = new Map(nodes.map((n) => [n.name, genKeypair()]));
  const encKp = genEncKeypair();
  const directory = {
    deployment: deployment.name, createdAt: new Date().toISOString(), hub: hub.eid, hubEncPub: encKp.pub,
    ratePerBundleSats: deployment.ratePerBundleSats ?? 50,
    clinics: Object.fromEntries(nodes.filter((n) => n.role === "clinic").map((n) => [n.eid, sign.get(n.name).pub])),
    relays: Object.fromEntries(nodes.filter((n) => n.role === "relay").map((n) => [n.eid, sign.get(n.name).pub])),
    payTo: Object.fromEntries(nodes.filter((n) => n.role === "relay" && n.payTo).map((n) => [n.eid, n.payTo])),
    nodes: nodes.map((n) => ({ name: n.name, role: n.role, eid: n.eid, next: n.next ?? null })),
  };
  const configs = Object.fromEntries(nodes.map((n) => {
    const c = {
      deployment: deployment.name, name: n.name, role: n.role, eid: n.eid, next: n.next ?? null,
      aap: n.aap ?? { host: "127.0.0.1", port: 4242 }, sign: exportKeypair(sign.get(n.name)), hubEncPub: encKp.pub,
      chunkSize: deployment.chunkSize ?? 1024,
    };
    if (n.role === "hub") Object.assign(c, {
      encPriv: encKp.priv, directory: { clinics: directory.clinics, relays: directory.relays, payTo: directory.payTo },
      ratePerBundleSats: directory.ratePerBundleSats, holdThresholdMs: deployment.holdThresholdMs ?? 10 * 60_000,
      dashboard: n.dashboard ?? { host: "127.0.0.1", port: 8080 },
    });
    return [n.name, c];
  }));
  return { directory, configs };
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname)) {
  const file = process.argv[2];
  const oi = process.argv.indexOf("--out");
  if (!file || oi < 0) { console.log("usage: node relief/kit/provision.mjs <deployment.json> --out <dir>"); process.exit(2); }
  const out = process.argv[oi + 1];
  if (existsSync(out) && readdirSync(out).length) { console.error(`refusing: ${out} is not empty (existing keys would be orphaned)`); process.exit(1); }
  const { directory, configs } = provision(JSON.parse(readFileSync(file, "utf8")));
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, "directory.json"), JSON.stringify(directory, null, 2) + "\n");
  for (const [name, c] of Object.entries(configs)) writeFileSync(join(out, `${name}.json`), JSON.stringify(c, null, 2) + "\n", { mode: 0o600 });
  console.log(`provisioned ${Object.keys(configs).length} nodes for "${directory.deployment}" in ${out}`);
  for (const n of directory.nodes) console.log(`  ${n.role.padEnd(6)} ${n.name.padEnd(18)} ${n.eid}${n.next ? `  -> ${n.next}` : ""}`);
  console.log(`each <node>.json holds a private key: copy it to that device only. directory.json is public.`);
}
