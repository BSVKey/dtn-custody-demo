// The running network: real BPv7 bundles moved hop by hop over computed contacts, in virtual
// time. At every node: take in the key records the bundle carries, then either deliver or
// route (cgr.mjs) and forward. Custodians sign a receipt v2 (fields 8 and 9) and pass on the
// key news they know; every forwarder adds 1 to the Hop Count block. Each node has its own
// keyring and learns only from what reaches it; the ground learns from operators at once.
import { encode, decode } from "../transport/bpv7/cbor.mjs";
import { encodeBundle, decodeBundle, BLOCK, CRC32C } from "../transport/bpv7/bundle.mjs";
import { stampBundleV2, verifyBundleV2 } from "../transport/bpv7/receipt-v2.mjs";
import { Keyring, issueKey, revokeKey, carryRecords, ingest, readKeyBlock, recordFields, keyIdOf, ROLE, KIND } from "../transport/bpv7/keyring.mjs";
import { genKeypair } from "../agent/lib/keys.mjs";
import { NODES, OPERATORS } from "./world.mjs";
import { route } from "./cgr.mjs";

const DTN_EPOCH = Date.UTC(2000, 0, 1);
export const dtn = (ms) => ms - DTN_EPOCH;
const DAY = 864e5;

// ---- Keys: each operator has a root (anchor) and an issuer; every node gets a key ----------
// A different world (nodes, operators) and key lifetime can be passed; the defaults are world.mjs.
export function provision(start, { nodes = NODES, operators = OPERATORS, keyDays = 30 } = {}) {
  const ops = {};
  for (const op of Object.keys(operators)) {
    const root = genKeypair(), issuer = genKeypair();
    ops[op] = { root, issuer, records: [issueKey(root, { subject: `${op}:issuer`, pub: issuer.pub, roles: ROLE.ISSUE | ROLE.REVOKE, notBefore: dtn(start) - DAY, notAfter: dtn(start) + Math.max(365, keyDays) * DAY })] };
  }
  const nodeKeys = {};
  for (const [eid, n] of Object.entries(nodes)) {
    const kp = genKeypair();
    nodeKeys[eid] = kp;
    ops[n.op].records.push(issueKey(ops[n.op].issuer, { subject: eid, pub: kp.pub, notBefore: dtn(start) - DAY, notAfter: dtn(start) + keyDays * DAY }));
  }
  const anchors = Object.entries(ops).map(([op, o]) => ({ name: op, pub: o.root.pub }));
  const launchRecords = Object.values(ops).flatMap((o) => o.records);
  return { ops, nodeKeys, anchors, launchRecords };
}

const hopCount = (b) => { const h = b.blocks.find((x) => x.type === BLOCK.HOP_COUNT); return h ? decode(h.data)[1] : null; };
function bumpHopCount(bytes) {
  const b = decodeBundle(bytes);
  return encodeBundle({ ...b, blocks: b.blocks.map((x) => (x.type === BLOCK.HOP_COUNT ? { ...x, data: encode([64, decode(x.data)[1] + 1]) } : x)) });
}

let seq = 0;
export function makeBundle({ src, dst, bytes, created, lifetimeDays = 7 }) {
  const payload = Buffer.alloc(bytes);
  for (let i = 0; i < bytes; i++) payload[i] = (i * 131 + seq * 17) & 0xff;
  seq++;
  return encodeBundle({
    primary: { crcType: CRC32C, dest: dst.replace(".0", ".1"), source: src.replace(".0", ".1"), created: [dtn(created), seq], lifetime: lifetimeDays * DAY },
    blocks: [
      { type: BLOCK.HOP_COUNT, number: 2, crcType: CRC32C, data: encode([64, 0]) },
      { type: BLOCK.PAYLOAD, number: 1, crcType: CRC32C, data: payload },
    ],
  });
}

// ---- The simulation ---------------------------------------------------------------------------
// traffic: [{ src, dst, bytes, created, label }]; events: [{ at, apply(net) }] (key compromise,
// revocation, rekey). Returns everything the reports and the clearing need.
export function runNetwork({ start, contacts, keys, traffic, events = [], nodes = NODES }) {
  const net = {
    start, contacts, keys,
    signer: { ...keys.nodeKeys },                                   // the key each node signs with now
    rings: {}, firstSeen: {}, deliveries: [], undelivered: [], log: [], groundRecords: [],
  };
  for (const eid of Object.keys(nodes)) {
    const ring = new Keyring({ anchors: keys.anchors });
    for (const r of keys.launchRecords) ring.add(r, dtn(start) - DAY);
    net.rings[eid] = ring;
    net.firstSeen[eid] = {};
  }
  const groundNodes = Object.keys(nodes).filter((e) => ["station", "moc"].includes(nodes[e].kind));
  net.publish = (record, at) => {   // an operator publishes a record: the ground has it at once
    net.groundRecords.push({ record, at });
    for (const g of groundNodes) noteRecord(g, record, at);
  };
  const noteRecord = (eid, record, at) => {
    if (net.rings[eid].add(record, dtn(at))) {
      const id = Buffer.from(encode(record)).toString("hex").slice(0, 24);
      net.firstSeen[eid][id] ??= at;
    }
  };
  net.recordId = (record) => Buffer.from(encode(record)).toString("hex").slice(0, 24);

  // Event queue (time-ordered).
  const q = [];
  const push = (e) => { let i = q.length; q.push(e); while (i > 0 && q[i - 1].t > e.t) { q[i] = q[i - 1]; i--; } q[i] = e; };
  for (const tr of traffic) push({ t: tr.created, kind: "arrive", node: tr.src, b: { ...tr, id: `${tr.label}`, bytes0: tr.bytes, data: makeBundle(tr), path: [], prev: tr.src } });
  for (const ev of events) push({ t: ev.at, kind: "event", ev });

  while (q.length) {
    const e = q.shift();
    if (e.kind === "event") { e.ev.apply(net, e.t); net.log.push({ t: e.t, what: e.ev.what }); continue; }
    const { node, b, t } = e;
    const N = nodes[node];
    // 1. Key news riding in the bundle.
    for (const r of readKeyBlock(decodeBundle(b.data))) noteRecord(node, r, t);
    for (const h of net.arrivalHooks || []) h(net, node, t);
    const prevHop = b.prev;
    const hc = hopCount(decodeBundle(b.data));
    // 2. Delivered?
    if (node === b.dst) {
      if (N.custodian) b.data = stampBundleV2(b.data, { kp: net.signer[node], eid: node }, { prevHop, receivedAt: dtn(t), forwardedAt: dtn(t), chain: true, hops: true });
      b.path.push({ node, arrive: t, depart: null, signed: N.custodian, hopCount: hc });
      const atDest = verifyBundleV2(b.data, { keyring: net.rings[node], arrivedAt: dtn(t), origin: b.src, lastNode: node });
      net.deliveries.push({ ...b, deliveredAt: t, atDest });
      continue;
    }
    // 3. Route on from here.
    const r = route(contacts, node, b.dst, t, b.data.length, { exclude: new Set(b.path.map((p) => p.node)) });
    if (!r || b.path.length > 20) { b.path.push({ node, arrive: t, depart: null }); net.undelivered.push({ ...b, stuckAt: node, t }); continue; }
    const c = r.hops[0];
    const depart = Math.max(t, c.start, c.nextFree ?? 0);
    // 4. Sign, pass on key news, count the hop.
    let data = b.data;
    if (N.custodian) {
      data = stampBundleV2(data, { kp: net.signer[node], eid: node }, { prevHop, receivedAt: dtn(t), forwardedAt: dtn(depart), chain: true, hops: true, hopsReleased: hc + 1 });
      data = carryRecords(data, net.rings[node].forCarriage(news(net, node)));
    }
    data = bumpHopCount(data);
    const tx = Math.ceil((data.length * 8 * 1000) / c.rateBps);
    c.nextFree = depart + tx;
    b.path.push({ node, arrive: t, depart, signed: N.custodian, hopCount: hc, contact: c.id });
    push({ t: depart + tx + c.owltMs, kind: "arrive", node: c.to, b: { ...b, data, prev: node, path: [...b.path] } });
  }
  return net;
}

// Key ids whose chains a custodian passes on: keys issued after launch (rekeys), so the news
// of a replacement key travels with the revocation of the old one.
function news(net, node) {
  const ids = [];
  for (const rec of net.rings[node].records.values()) {
    if (rec.f.kind === KIND.KEY && rec.seenAt > dtn(net.start)) ids.push(keyIdOf(spki(rec.f.pub)).toString("hex"));
  }
  return ids;
}
const spki = (raw) => Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), Buffer.from(raw)]).toString("base64");

// ---- The compromise scenario --------------------------------------------------------------------
// At `stolenAt` a copy of `victim`'s key leaves its holder's control. At `detectAt` the operator
// revokes it (effective from stolenAt), issues a replacement and publishes both on the ground;
// spacecraft hear only through traffic. The victim switches to its new key once the record
// reaches it.
export function compromise({ victim, stolenAt, detectAt }) {
  const state = { victim, stolenAt, detectAt, stolenKey: null, newKey: null, switchedAt: null, records: [] };
  const events = [
    { at: stolenAt, what: `key of ${NODES[victim].name} copied by an attacker`, apply: (net) => { state.stolenKey = net.signer[victim]; } },
    { at: detectAt, what: `operator revokes it (effective from the theft) and issues a replacement`, apply: (net, t) => {
      const op = net.keys.ops[NODES[victim].op];
      state.newKey = genKeypair();
      const rev = revokeKey(op.issuer, { target: state.stolenKey.pub, effectiveFrom: dtn(stolenAt), reason: "key copied", issuedAt: dtn(t) });
      const rep = issueKey(op.issuer, { subject: victim, pub: state.newKey.pub, notBefore: dtn(t), notAfter: dtn(t) + 30 * DAY, issuedAt: dtn(t), replaces: state.stolenKey.pub });
      state.records = [rev, rep];
      for (const r of state.records) net.publish(r, t);
      net.arrivalHooks = [...(net.arrivalHooks || []), (n, node, at) => {
        if (node === victim && !state.switchedAt && n.rings[node].pubsFor(victim).includes(state.newKey.pub)) {
          n.signer[victim] = state.newKey; state.switchedAt = at;
        }
      }];
    } },
  ];
  return { state, events };
}
