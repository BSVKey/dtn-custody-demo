// The space links and the three JS endpoints of the Solar System Internet on real Hardy BPAs.
// One process registers as a convergence layer (gRPC CLA API) on every Hardy node and adds
// each neighbour as a peer. When a BPA forwards a bundle, the link is emulated here: it leaves
// only while the contact from geometry is open, takes the link's light time and transmission
// time (both compressed with the plan), and is dispatched into the next BPA. Storage across
// gaps and routing are Hardy's own (its time-variant routing agent follows the CGR schedule);
// receipts at every custodian are signed by Hardy's custody-receipt filter.
// Endpoints: mission operations (ipn:1, behind every ground station), the lander and rover
// payload computers (ipn:51 and ipn:61, on local links to their BPAs) originate bundles with
// the first receipt and verify whole chains on arrival with their own keyrings.
//   node ssi/hardy/net.mjs <dir>        (inside the dtn-custody-hardy-custodian image)
import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { encode, decode } from "../../transport/bpv7/cbor.mjs";
import { encodeBundle, decodeBundle, BLOCK, CRC32C } from "../../transport/bpv7/bundle.mjs";
import { stampBundleV2, verifyBundleV2, readBlockItems, receiptFields } from "../../transport/bpv7/receipt-v2.mjs";
import { Keyring, revokeKey, carryRecords, ingest, readKeyBlock, recordFields } from "../../transport/bpv7/keyring.mjs";
import { route } from "../cgr.mjs";
import { keyFromSeed } from "./plan.mjs";

const require = createRequire("/opt/grpc/");
const grpc = require("@grpc/grpc-js");
const loader = require("@grpc/proto-loader");
const { cla } = grpc.loadPackageDefinition(loader.loadSync("cla.proto", { includeDirs: ["/app/hardy/proto"], keepCase: true, longs: Number, enums: String, defaults: true, oneofs: true }));

const dir = process.argv[2];
const P = JSON.parse(readFileSync(`${dir}/plan.json`, "utf8"));
const H = 3.6e6, DTN_EPOCH = Date.UTC(2000, 0, 1), now = () => Date.now(), dtnNow = () => Date.now() - DTN_EPOCH;
const real = (scenarioH) => P.t0 + (scenarioH * H) / P.scale;
const log = (m) => console.log(`[net +${((now() - P.t0) / 1000).toFixed(1)}s] ${m}`);
const isHardy = new Set(P.hardy.map((h) => h.eid));
const records = P.records.map((h) => decode(Buffer.from(h, "hex")));
const anchors = Object.entries(P.ops).map(([op, k]) => ({ name: op, pub: keyFromSeed(k.root).pub }));

// ---- Endpoints ---------------------------------------------------------------------------
const EP = {};
for (const eid of Object.keys(P.endpoints)) {
  const ring = new Keyring({ anchors });
  for (const r of records) ring.add(r, dtnNow() - 864e5);
  EP[eid] = { eid, kp: keyFromSeed(P.seeds[eid]), ring };
}
const trace = [], deliveries = [], problems = [];
const stats = { forwards: 0, heldByLink: 0, dispatchRefused: 0 };

// ---- One CLA session per Hardy node ----------------------------------------------------------
const sessions = {};
let msgId = 100;
const neighbours = (x) => [...new Set(P.contacts.filter((c) => c.from === x).map((c) => c.to))];
const local = { "ipn:50.0": "ipn:51.0", "ipn:60.0": "ipn:61.0" };
function connect(h) {
  return new Promise((resolve) => {
    const s = new cla.Cla(`[::1]:${h.port}`, grpc.credentials.createInsecure()).Register();
    const peers = [...neighbours(h.eid), ...(local[h.eid] ? [local[h.eid]] : [])];
    let added = 0;
    s.write({ msg_id: 1, register: { name: "space-links", address_type: "CLA_ADDRESS_TYPE_PRIVATE" } });
    s.on("data", (m) => {
      if (m.register) {
        for (const y of peers) s.write({ msg_id: msgId++, add_peer: { node_ids: [y], address: { address_type: "CLA_ADDRESS_TYPE_PRIVATE", address: Buffer.from(`${h.eid}>${y}`) } } });
      } else if (m.add_peer) {
        if (!m.add_peer.added) problems.push(`${h.eid}: a peer was not added`);
        if (++added === peers.length) resolve();
      } else if (m.forward) {
        s.write({ msg_id: m.msg_id, forward: { sent: {} } });
        const [x, y] = Buffer.from(m.forward.address.address).toString().split(">");
        onForward(x, y, Buffer.from(m.forward.bundle));
      } else if (m.dispatch) {
        if (m.dispatch.verdict !== "DISPATCH_VERDICT_ACCEPTED") { stats.dispatchRefused++; problems.push(`${h.eid} refused a dispatch: ${m.dispatch.verdict}`); }
      } else if (m.status && m.status.code) {
        problems.push(`${h.eid} status ${m.status.code}: ${m.status.message}`);
      }
    });
    s.on("error", (e) => problems.push(`${h.eid} stream error: ${e.message}`));
    sessions[h.eid] = s;
  });
}
const keyOf = (bytes) => { const p = decodeBundle(bytes).primary; return `${p.source}/${p.created[1]}`; };
const dispatch = (into, bytes, from) => sessions[into].write({ msg_id: msgId++, dispatch: { bundle: bytes, peer_node_id: from } });

// A BPA handed us a bundle for peer y: carry it across the emulated link.
function onForward(x, y, bytes) {
  stats.forwards++;
  trace.push({ t: now(), from: x, to: y, bundle: keyOf(bytes) });
  if (EP[y]) return setTimeout(() => arrive(y, bytes, x), 1);
  const t = now();
  const c = P.contacts.find((k) => k.from === x && k.to === y && k.end > t && k.start <= t + 2000);
  if (!c) { problems.push(`no contact ${x}>${y} near ${((t - P.t0) / 1000).toFixed(1)} s`); return; }
  const wait = Math.max(0, c.start - t);
  if (wait > 0) stats.heldByLink++;
  const delay = wait + (bytes.length * 8 * 1000) / c.rateBps + c.owltMs;
  setTimeout(() => dispatch(y, bytes, x), delay);
}

// ---- Endpoint behaviour ----------------------------------------------------------------------
const byKey = new Map();
function originate({ src, dst, bytes, label }) {
  const E = EP[src];
  let b = encodeBundle({
    primary: { crcType: CRC32C, dest: dst.replace(".0", ".1"), source: src.replace(".0", ".1"), created: [dtnNow(), byKey.size + 1], lifetime: 3600000 },
    blocks: [
      { type: BLOCK.HOP_COUNT, number: 2, crcType: CRC32C, data: encode([64, 0]) },
      { type: BLOCK.PAYLOAD, number: 1, crcType: CRC32C, data: Buffer.alloc(bytes, label.length) },
    ],
  });
  // ENDPOINT_RELAY=0: the payload computers learn key news but do not pass it on, so any
  // revocation on their bundles at arrival was added by a Hardy node on the way.
  const news = src === "ipn:1.0" || process.env.ENDPOINT_RELAY !== "0" ? E.ring.forCarriage([]) : [];
  if (news.length) b = carryRecords(b, news);
  b = stampBundleV2(b, { kp: E.kp, eid: src }, { prevHop: src, receivedAt: dtnNow(), forwardedAt: dtnNow(), chain: true, hops: true });
  byKey.set(keyOf(b), { label, src, dst, sent: now(), revocationAtOrigin: hasRevocation(b) });
  send(src, b);
}
function send(from, b) {
  if (from === "ipn:1.0") {
    // Mission operations reaches the ground stations by terrestrial network: pick the station
    // on the earliest-arrival route to the bundle's destination.
    const dst = decodeBundle(b).primary.dest.replace(/\.\d+$/, ".0"), target = { "ipn:51.0": "ipn:50.0", "ipn:61.0": "ipn:60.0" }[dst];
    const r = route(P.contacts, "ipn:1.0", target, now(), b.length);
    if (!r) { problems.push(`no route from mission operations to ${target}`); return; }
    return dispatch(r.hops[0].to, b, "ipn:1.0");
  }
  dispatch({ "ipn:51.0": "ipn:50.0", "ipn:61.0": "ipn:60.0" }[from], b, from);
}
const hasRevocation = (bytes) => readKeyBlock(decodeBundle(bytes)).some((r) => recordFields(r).kind === 2);
function arrive(e, bytes, prev) {
  const E = EP[e];
  const learned = ingest(E.ring, bytes, dtnNow());
  const revocationOnArrival = hasRevocation(bytes);
  if (revocationOnArrival && !E.heardAt) E.heardAt = now();
  const final = stampBundleV2(bytes, { kp: E.kp, eid: e }, { prevHop: prev, receivedAt: dtnNow(), forwardedAt: dtnNow(), chain: true, hops: true });
  const meta = byKey.get(keyOf(bytes)) || {};
  const v = verifyBundleV2(final, { keyring: E.ring, arrivedAt: dtnNow(), origin: meta.src, lastNode: e });
  deliveries.push({ ...meta, at: e, delivered: now(), learned, revocationOnArrival, ok: v.ok, reason: v.reason, gaps: v.gaps, data: final.toString("hex") });
  log(`${meta.label} delivered to ${P.endpoints[e].name}: ${v.ok ? "chain verified" : "REFUSED " + v.reason}${v.gaps?.length ? `, gap ${JSON.stringify(v.gaps[0])}` : ""}`);
}

// ---- The scenario -------------------------------------------------------------------------------
const HOURS_TRAFFIC = P.hours - 6;
const traffic = [];
for (let h = 0.5; h < HOURS_TRAFFIC; h += 2) traffic.push({ at: h, src: "ipn:51.0", dst: "ipn:1.0", bytes: 20000, label: `lander-tlm-${h}` });
for (let h = 1; h < HOURS_TRAFFIC; h += 4) traffic.push({ at: h, src: "ipn:61.0", dst: "ipn:1.0", bytes: 50000, label: `rover-img-${h}` });
for (let h = 1.5; h < HOURS_TRAFFIC; h += 6) traffic.push({ at: h, src: "ipn:1.0", dst: "ipn:51.0", bytes: 2000, label: `cmd-lander-${h}` });
for (let h = 2; h < HOURS_TRAFFIC; h += 6) traffic.push({ at: h, src: "ipn:1.0", dst: "ipn:61.0", bytes: 2000, label: `cmd-rover-${h}` });
const THEFT_H = 6, DETECT_H = 10, VICTIM = "ipn:21.0";

await Promise.all(P.hardy.map(connect));
log(`space links registered on ${P.hardy.length} Hardy BPAs; ${traffic.length} bundles scheduled`);
writeFileSync(`${dir}/net.ready`, "1");
for (const tr of traffic) setTimeout(() => originate(tr), Math.max(0, real(tr.at) - now()));
setTimeout(() => {
  // The victim's operator revokes the copied key, effective from the theft. Mission operations
  // has it at once and passes it on in every command it sends.
  const op = P.hardy.find((h) => h.eid === VICTIM).op;
  const rev = revokeKey(keyFromSeed(P.ops[op].issuer), { target: keyFromSeed(P.seeds[VICTIM]).pub, effectiveFrom: real(THEFT_H) - DTN_EPOCH, reason: "key copied" });
  EP["ipn:1.0"].ring.add(rev, dtnNow());
  EP["ipn:1.0"].heardAt = now();
  writeFileSync(`${dir}/revocation.hex`, Buffer.from(encode(rev)).toString("hex"));
  log(`revocation of ${VICTIM}'s key published (effective from scenario +${THEFT_H} h)`);
}, Math.max(0, real(DETECT_H) - now()));

setTimeout(() => {
  const heard = Object.fromEntries(Object.entries(EP).map(([e, E]) => [e, E.heardAt ? +(((E.heardAt - real(DETECT_H)) * P.scale) / H).toFixed(2) : null]));
  writeFileSync(`${dir}/results.json`, JSON.stringify({ traffic, deliveries, trace, stats, problems, heard, theft: real(THEFT_H), detect: real(DETECT_H), victim: VICTIM }));
  log(`done: ${deliveries.length} of ${traffic.length} delivered, ${stats.forwards} forwards, ${problems.length} problems`);
  process.exit(0);
}, real(P.hours) - now() + 20000);
