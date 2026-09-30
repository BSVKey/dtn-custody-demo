#!/usr/bin/env node
// Custody receipts over IP store-and-forward, built from a QUIC workbench simulation.
//
// The workbench (github.com/deepspaceip/dipt-quic-workbench, by the authors of
// draft-ietf-tiptop-ip-architecture) forwards IP packets hop by hop with store-and-forward
// buffers and scheduled link outages, and writes every packet event to replay-log.json. This
// script reads that log and produces, without touching the forwarding path:
//
//   - one signed custody-batch/1 receipt per receiving node per contact (a link's up period),
//     committing to every packet the node took in over that link, by Merkle root;
//   - one gap/1 record per link outage;
//   - for every packet that never reached an application, the last node that signed for it and
//     what that node's own log says happened (buffer cleared, buffer full, sent into an outage).
//
// QUIC still recovers losses end to end. The receipts do not change delivery; they record, after
// the fact, which operator's node held what, so losses can be attributed between operators.
//
//   node ip-sf/receipts.mjs --dir=<run folder with replay-log.json> --graph=<networkgraph.json>
//        [--events=<events.json>] [--name=<scenario>] [--quic=<workbench stdout file>]
import { readFileSync, existsSync } from "node:fs";
import { genKeypair } from "../agent/lib/keys.mjs";
import { verifyRecord } from "../agent/lib/receipt.mjs";
import { batchReceipt, batchProof, inBatch } from "../agent/lib/batch.mjs";

const arg = (k, d) => process.argv.find((a) => a.startsWith(`--${k}=`))?.split("=").slice(1).join("=") ?? d;
const dir = arg("dir");
const graph = JSON.parse(readFileSync(arg("graph"), "utf8"));
const events = arg("events") && existsSync(arg("events")) ? JSON.parse(readFileSync(arg("events"), "utf8")).events : [];
const steps = JSON.parse(readFileSync(`${dir}/replay-log.json`, "utf8"));
const name = arg("name", dir);
const fmt = (n) => Math.round(n).toLocaleString("en-US");
const NS = 1e6; // replay times are nanoseconds; work in milliseconds

// Link endpoints: which node sends and which receives on each link id.
const nodeOfIp = new Map();
for (const n of graph.nodes) for (const i of n.interfaces) for (const a of i.addresses) nodeOfIp.set(a.address.split("/")[0], n.id);
const linkEnds = new Map(graph.links.map((l) => [l.id, { from: nodeOfIp.get(l.source), to: nodeOfIp.get(l.target) }]));

// Up periods per link from the event file. Links with no events are always up; they are cut into
// 10-minute windows so they get periodic receipts like everything else.
const upPeriods = new Map();
const downPeriods = new Map();
const endMs = Math.max(...steps.map((s) => s.relative_time_ns / NS)) + 1;
for (const id of linkEnds.keys()) {
  const evs = events.filter((e) => e.link?.id === id).sort((a, b) => a.relative_time_ms - b.relative_time_ms);
  const ups = [], downs = [];
  if (!evs.length) { for (let t = 0; t < endMs; t += 600000) ups.push([t, Math.min(t + 600000, endMs)]); }
  else {
    let state = "up", since = 0; // links start up unless the first event says otherwise
    if (evs[0].link.status === "up") state = "down";
    for (const e of evs) {
      if (e.link.status === state) continue;
      (state === "up" ? ups : downs).push([since, e.relative_time_ms]);
      state = e.link.status; since = e.relative_time_ms;
    }
    (state === "up" ? ups : downs).push([since, Math.max(since, endMs)]);
  }
  upPeriods.set(id, ups); downPeriods.set(id, downs);
}
const windowOf = (link, t) => upPeriods.get(link).findIndex(([a, b]) => t >= a && t <= b);

// Walk the log.
const arrivals = new Map();   // packetId -> [{ node, t }]
const lastTransit = new Map(); // packetId -> { from, link, t }  (the hop in flight)
const inboundLink = new Map(); // `${packetId}@${node}` -> link it arrived on
const drops = [];             // { packetId, node, reason, t }
const lostInTransit = [];     // { packetId, link, t }
const delivered = new Set();
const created = new Map();    // packetId -> node that created it
let packetHops = 0;
for (const s of steps) {
  const t = s.relative_time_ns / NS, d = s.data;
  switch (s.type) {
    case "packetInNode": {
      const tr = lastTransit.get(d.packet_id);
      if (!tr) { created.set(d.packet_id, d.node_id); break; }
      if (d.dropped_on_arrival) { drops.push({ packetId: d.packet_id, node: d.node_id, reason: "DroppedOnArrival", t }); }
      (arrivals.get(d.packet_id) || arrivals.set(d.packet_id, []).get(d.packet_id)).push({ node: d.node_id, t });
      inboundLink.set(`${d.packet_id}@${d.node_id}`, tr.link);
      packetHops++;
      break;
    }
    case "packetInTransit": lastTransit.set(d.packet_id, { from: d.node_id, link: d.link_id, t }); break;
    case "packetDropped": drops.push({ packetId: d.packet_id, node: d.node_id, reason: d.reason, t }); break;
    case "packetLostInTransit": lostInTransit.push({ packetId: d.packet_id, link: d.link_id, t }); break;
    case "packetDeliveredToApplication": delivered.add(d.packet_id); break;
  }
}

// One signed batch receipt per (receiving node, inbound link, contact window).
const keys = new Map();
const keyOf = (node) => keys.get(node) || keys.set(node, genKeypair()).get(node);
const groups = new Map();
for (const [pid, hops] of arrivals) for (const h of hops) {
  const link = inboundLink.get(`${pid}@${h.node}`);
  const w = windowOf(link, lastTransit.has(pid) ? h.t : h.t);
  const key = `${h.node}|${link}|${w}`;
  const g = groups.get(key) || groups.set(key, { node: h.node, link, w, ids: [], from: h.t, to: h.t }).get(key);
  g.ids.push(pid); g.from = Math.min(g.from, h.t); g.to = Math.max(g.to, h.t);
}
const batches = [];
const receiptOf = new Map(); // `${packetId}@${node}` -> batch
for (const g of groups.values()) {
  const b = batchReceipt(keyOf(g.node), { prevHop: linkEnds.get(g.link).from, thisHop: g.node, contactId: `${g.link}#${g.w}`, from: Math.round(g.from), to: Math.round(g.to), bundleIds: g.ids });
  batches.push(b);
  for (const id of g.ids) receiptOf.set(`${id}@${g.node}`, b);
}
const gaps = [...downPeriods].flatMap(([link, ds]) => ds.filter(([a, b]) => b > a).map(([a, b]) => ({ kind: "gap/1", link, downAt: a, upAt: b })));

// Every receipt verifies and is signed by the pinned key of the node it names.
const pins = new Map([...keys].map(([n, k]) => [n, k.pub]));
const badReceipts = batches.filter((b) => !verifyRecord(b.receipt).ok || b.receipt.signerPub !== pins.get(b.receipt.thisHop)).length;

// Attribute every packet that never reached an application to the last node that signed for it.
const everDelivered = (pid) => delivered.has(pid);
const lost = [...created.keys()].filter((pid) => !everDelivered(pid));
const attribution = {};
const examples = [];
for (const pid of lost) {
  const hops = arrivals.get(pid) || [];
  const last = hops.at(-1);
  let who, why;
  if (!last) { who = created.get(pid); why = lastTransit.has(pid) ? (lostInTransit.some((x) => x.packetId === pid) ? "lost in transit (link went down)" : "still in flight when the simulation ended") : "not yet sent when the simulation ended"; }
  else {
    who = last.node;
    const p = batchProof(receiptOf.get(`${pid}@${who}`), pid);
    if (!inBatch(receiptOf.get(`${pid}@${who}`).receipt, pid, p)) throw new Error("receipt does not cover a packet it should");
    const dr = drops.find((x) => x.packetId === pid && x.node === who);
    const lt = lostInTransit.find((x) => x.packetId === pid);
    why = dr ? `dropped: ${dr.reason}` : lt ? `sent into link ${lt.link} as it went down` : "held when the simulation ended";
  }
  const k = `${who}: ${why}`;
  attribution[k] = (attribution[k] || 0) + 1;
  if (examples.length < 3) examples.push({ packetId: pid, lastSigner: who, why, receipt: last ? receiptOf.get(`${pid}@${who}`).receipt.claimId : null });
}

const quic = arg("quic") && existsSync(arg("quic")) ? readFileSync(arg("quic"), "utf8") : "";
const quicLine = (quic.match(/.*DONE.*/g) || []).join(" | ");
const summary = {
  scenario: name,
  packetsCreated: created.size,
  packetHops,
  deliveredToApplication: delivered.size,
  notDelivered: lost.length,
  receipts: batches.length,
  receiptsVerified: batches.length - badReceipts,
  signaturesPerPacketHop: +(batches.length / Math.max(1, packetHops)).toFixed(4),
  gapRecords: gaps.length,
  attribution,
  examples,
  quic: quicLine || undefined,
};
console.log(JSON.stringify(summary, null, 2));
process.exit(badReceipts ? 1 : 0);
