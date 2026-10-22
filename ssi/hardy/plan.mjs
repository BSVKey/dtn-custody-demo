// Plan for the Solar System Internet on real BPAs: every spacecraft and station of ssi/world.mjs
// becomes a Hardy node (Aalyria's Hardy, built with our custody-receipt filter), and each gets
// its own time-variant routing schedule (hardy-tvr) of next hops, compiled offline by contact
// graph routing (ssi/cgr.mjs) from the contacts computed from geometry. Time is compressed by
// SCALE: scenario time s runs at real time t0 + (s - start) / SCALE.
//   node ssi/hardy/plan.mjs <dir> <t0EpochMs>
// Writes <dir>/plan.json (everything net.mjs needs), <dir>/n<N>/{bpa.yaml,tvr.toml,contacts,seed}.
import { mkdirSync, writeFileSync } from "node:fs";
import { createPrivateKey, createPublicKey, generateKeyPairSync } from "node:crypto";
import { NODES, OPERATORS, computeContacts } from "../world.mjs";
import { route } from "../cgr.mjs";
import { issueKey, ROLE } from "../../transport/bpv7/keyring.mjs";
import { encode } from "../../transport/bpv7/cbor.mjs";

export const SCALE = Number(process.env.SSI_SCALE || 120);
export const SCENARIO_START = Date.parse("2026-10-22T00:00:00Z");
export const HOURS = Number(process.env.SSI_HOURS || 24);
const H = 3.6e6, DAY = 864e5, DTN_EPOCH = Date.UTC(2000, 0, 1);

// Hardy nodes (everything but mission operations); JS endpoints sit beside them on local links.
export const HARDY = Object.keys(NODES).filter((e) => NODES[e].kind !== "moc");
export const ENDPOINTS = { "ipn:1.0": { name: "Mission operations", via: null }, "ipn:51.0": { name: "Lander payload computer", via: "ipn:50.0" }, "ipn:61.0": { name: "Rover payload computer", via: "ipn:60.0" } };
const num = (eid) => Number(eid.split(":")[1].split(".")[0]);
export const port = (eid) => 50000 + num(eid);

export function keyFromSeed(seedHex) {
  const priv = createPrivateKey({ key: Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), Buffer.from(seedHex, "hex")]), format: "der", type: "pkcs8" });
  return { priv, pub: createPublicKey(priv).export({ type: "spki", format: "der" }).toString("base64") };
}
const freshSeed = () => generateKeyPairSync("ed25519").privateKey.export({ format: "der", type: "pkcs8" }).subarray(-32).toString("hex");

export function makePlan(dir, t0) {
  const toReal = (s) => t0 + (s - SCENARIO_START) / SCALE;
  const contacts = computeContacts(SCENARIO_START, HOURS);
  const iso = (ms) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");

  // Keys: per operator a root and an issuer; per node a seed (Hardy reads it from a file).
  const seeds = {}, ops = {};
  for (const op of Object.keys(OPERATORS)) ops[op] = { root: freshSeed(), issuer: freshSeed() };
  for (const eid of [...HARDY, ...Object.keys(ENDPOINTS)]) seeds[eid] = freshSeed();
  const opOf = (eid) => NODES[eid]?.op ?? "science";
  const nb = t0 - DTN_EPOCH - DAY, na = t0 - DTN_EPOCH + 30 * DAY;
  const records = [];
  for (const [op, k] of Object.entries(ops)) {
    records.push(issueKey(keyFromSeed(k.root), { subject: `${op}:issuer`, pub: keyFromSeed(k.issuer).pub, roles: ROLE.ISSUE | ROLE.REVOKE, notBefore: nb, notAfter: na }));
  }
  for (const [eid, s] of Object.entries(seeds)) records.push(issueKey(keyFromSeed(ops[opOf(eid)].issuer), { subject: eid, pub: keyFromSeed(s).pub, notBefore: nb, notAfter: na }));

  // Next-hop schedules: for each Hardy node and destination, sample CGR at every contact edge.
  const targets = { "ipn:1": "ipn:1.0", "ipn:51": "ipn:50.0", "ipn:61": "ipn:60.0" };
  const edges = [...new Set(contacts.flatMap((c) => [c.start, c.end]))].sort((a, b) => a - b);
  const tvr = {};
  for (const x of HARDY) {
    const lines = [`# ${NODES[x].name} (${x}): next hops by contact graph routing, scenario x${SCALE} compressed, time zero ${iso(t0)}`];
    for (const [pat, target] of Object.entries(targets)) {
      if (x === target) { lines.push(`${pat}.* via ${pat}.0 start ${iso(t0 - 60000)} end ${iso(toReal(SCENARIO_START + HOURS * H) + 600000)}`); continue; }
      let cur = null;
      const flush = (end) => {
        if (!cur) return;
        const s = Math.ceil(toReal(cur.from) / 1000) * 1000, e = Math.floor(toReal(end) / 1000) * 1000;
        if (e > s) lines.push(`${pat}.* via ${cur.via} start ${iso(s)} end ${iso(e)}`);
        cur = null;
      };
      for (let i = 0; i < edges.length - 1; i++) {
        const t = edges[i];
        const r = route(contacts, x, target, t, 20000);
        const c = r?.hops[0];
        // A route is usable only while its first contact is open.
        const open = c && c.start <= t && c.end > t ? c : null;
        const via = open ? open.to : null;
        if (!cur || cur.via !== via) { flush(t); if (via) cur = { via, from: t }; }
        if (cur && open && open.end < edges[i + 1]) { flush(open.end); }
      }
      flush(edges.at(-1));
    }
    tvr[x] = lines.join("\n") + "\n";
  }

  for (const x of HARDY) {
    const d = `${dir}/n${num(x)}`;
    mkdirSync(d, { recursive: true });
    writeFileSync(`${d}/seed`, seeds[x] + "\n", { mode: 0o600 });
    writeFileSync(`${d}/contacts`, tvr[x]);
    // Each routing agent also serves its own gRPC API; one port per node so they can share a host.
    writeFileSync(`${d}/tvr.toml`, `bpa-address = "http://[::1]:${port(x)}"\ncontact-plan = "${d}/contacts"\ngrpc-listen = "[::1]:${port(x) - 10000}"\n`);
    const custody = NODES[x].custodian ? `custody-receipt:\n  eid: "${x}"\n  key-file: "${d}/seed"\n  policy: always\n${process.env.CHAIN_AND_HOPS === "1" ? "  chain-and-hops: true\n" : ""}${process.env.GOSSIP === "1" ? "  gossip-revocations: true\n" : ""}` : "";
    writeFileSync(`${d}/bpa.yaml`, `log-level: info\nadmin-endpoints: ["${x}"]\ngrpc:\n  address: "[::1]:${port(x)}"\n  services: [application, cla, service, routing]\nstorage:\n  metadata: { type: memory }\n  bundle: { type: memory }\nclas: []\n${custody}`);
  }
  const plan = {
    t0, scale: SCALE, scenarioStart: SCENARIO_START, hours: HOURS,
    hardy: HARDY.map((e) => ({ eid: e, port: port(e), name: NODES[e].name, op: NODES[e].op, custodian: NODES[e].custodian })),
    endpoints: ENDPOINTS,
    contacts: contacts.map((c) => ({ from: c.from, to: c.to, start: toReal(c.start), end: toReal(c.end), owltMs: c.owltMs / SCALE, rateBps: c.rateBps * SCALE })),
    seeds, ops, records: records.map((r) => Buffer.from(encode(r)).toString("hex")),
    routeLines: Object.fromEntries(HARDY.map((x) => [x, tvr[x].split("\n").length - 2])),
  };
  writeFileSync(`${dir}/plan.json`, JSON.stringify(plan));
  return plan;
}

if (process.argv[1]?.endsWith("plan.mjs")) {
  const [dir, t0] = process.argv.slice(2);
  const p = makePlan(dir, Number(t0));
  console.log(`[plan] ${p.hardy.length} Hardy nodes, ${p.contacts.length} contacts, x${p.scale} compressed (${p.hours} h in ${(p.hours * 60 / p.scale).toFixed(0)} min), route lines per node: ${Object.values(p.routeLines).join(" ")}`);
}
