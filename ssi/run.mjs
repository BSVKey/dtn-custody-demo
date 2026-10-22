// The accountable Solar System Internet, one run: five operators, contacts from geometry,
// real BPv7 bundles routed by CGR with custody receipts and in-band keys, a relay key stolen
// and revoked mid-run, forged billing claims, and clearing between operators from receipts.
//   node ssi/run.mjs [--json] [--write]   (--write: ssi/RESULTS-data.json for the explorer)
import { writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { encode } from "../transport/bpv7/cbor.mjs";
import { decodeBundle, encodeBundle, putBlock, BLOCK_FLAG, CRC32C } from "../transport/bpv7/bundle.mjs";
import { stampBundleV2, readBlockItems, receiptFields, bundleIdentity } from "../transport/bpv7/receipt-v2.mjs";
import { CUSTODY_BLOCK_TYPE } from "../transport/bpv7/custody-block.mjs";
import { verify1 } from "../transport/bpv7/cose.mjs";
import { verifyRecord } from "../agent/lib/receipt.mjs";
import { NODES, OPERATORS, computeContacts, operatorPlans } from "./world.mjs";
import { provision, runNetwork, compromise, makeBundle, dtn } from "./network.mjs";
import { clear } from "./settle.mjs";
import { signPlan, verifyPlan } from "../contact-plans/sign.mjs";
import { toIon, toHdtn } from "../contact-plans/compile.mjs";

const H = 3.6e6;
export function runSSI({ start = Date.parse("2026-10-22T00:00:00Z"), hours = 72, trafficHours = 48, victim = "ipn:21.0", stolenH = 14, detectH = 20 } = {}) {
  const contacts = computeContacts(start, hours);
  const keys = provision(start);

  // Every operator signs the contact plan for the links it transmits on.
  const plans = operatorPlans(contacts, start), signedPlans = {};
  for (const [op, plan] of Object.entries(plans)) {
    if (!plan.contacts.length) continue;
    const exports = { ion: toIon({ ...plan, delays: plan.delays }), hdtn: JSON.stringify(toHdtn(plan)) };
    const rec = signPlan(keys.ops[op].issuer, { plan, exports, network: "ssi", version: 1, validFrom: plan.epoch, validTo: new Date(start + hours * H).toISOString() });
    signedPlans[op] = { contacts: plan.contacts.length, ok: verifyPlan(rec, { pub: keys.ops[op].issuer.pub, plan, exports }).ok, claimId: rec.claimId };
  }

  const traffic = [];
  const every = (hrs, f) => { for (let h = 0.5; h < trafficHours; h += hrs) traffic.push(f(start + h * H)); };
  let n = 0;
  every(2, (t) => ({ src: "ipn:50.0", dst: "ipn:1.0", bytes: 20000, created: t, label: `lander-tlm-${++n}` }));
  every(4, (t) => ({ src: "ipn:60.0", dst: "ipn:1.0", bytes: 150000, created: t, label: `rover-img-${++n}` }));
  every(6, (t) => ({ src: "ipn:1.0", dst: "ipn:50.0", bytes: 2000, created: t, label: `cmd-lander-${++n}` }));
  every(6, (t) => ({ src: "ipn:1.0", dst: "ipn:60.0", bytes: 2000, created: t, label: `cmd-rover-${++n}` }));

  const cmp = compromise({ victim, stolenAt: start + stolenH * H, detectAt: start + detectH * H });
  const net = runNetwork({ start, contacts, keys, traffic, events: cmp.events });
  const end = start + hours * H;

  // ---- The attacker, holding the stolen relay key, bills for carriage it never did ----
  const stolen = { kp: cmp.state.stolenKey, eid: victim };
  const T = cmp.state.stolenAt;
  const notVia = net.deliveries.filter((d) => !d.path.some((p) => p.node === victim) && d.dst === "ipn:1.0");
  const lastOf = (d) => receiptFields(readBlockItems(decodeBundle(d.data)).items.at(-1));
  const withItems = (bytes, items) => encodeBundle(putBlock(decodeBundle(bytes), { type: CUSTODY_BLOCK_TYPE, flags: BLOCK_FLAG.REPLICATE_IN_FRAGMENTS, crcType: CRC32C, data: encode(items) }));
  const forge = (bytes, at, prev) => stampBundleV2(bytes, stolen, { prevHop: prev, receivedAt: dtn(at), forwardedAt: dtn(at + 60000), chain: true });
  const forged = [];
  { const d = notVia[0]; forged.push({ note: "appended, backdated before the theft", data: forge(d.data, T - 2 * H, lastOf(d).thisHop) }); }
  { const d = notVia[1], items = readBlockItems(decodeBundle(d.data)).items;
    const cut = withItems(d.data, items.slice(0, -1));
    const spliced = readBlockItems(decodeBundle(forge(cut, T - 3 * H, receiptFields(items.at(-2)).thisHop))).items;
    forged.push({ note: "spliced ahead of the destination's receipt", data: withItems(d.data, [...spliced, items.at(-1)]) }); }
  { const d = notVia[2]; forged.push({ note: "signed at its true time, after the theft", data: forge(d.data, T + 3 * H, lastOf(d).thisHop) }); }
  { const fake = makeBundle({ src: "ipn:50.0", dst: "ipn:1.0", bytes: 20000, created: T - 5 * H });
    forged.push({ note: "a bundle that was never delivered", data: forge(fake, T - 4 * H, "ipn:50.0") }); }
  { const d = notVia[3]; forged.push({ note: "an honest delivery submitted a second time", data: d.data }); }

  // ---- Clearing at the end of the period, with the ground's knowledge of keys ----
  const delivered = new Set(net.deliveries.map((d) => JSON.stringify(bundleIdentity(decodeBundle(d.data)))));
  const claims = [
    ...net.deliveries.map((d) => ({ data: d.data, arrivedAt: dtn(d.deliveredAt), source: "delivery", note: d.id })),
    ...forged.map((f) => ({ data: f.data, arrivedAt: dtn(end), source: "submitted", note: f.note })),
  ];
  const period = { from: new Date(start).toISOString(), to: new Date(end).toISOString() };
  const clearing = clear({ claims, keyring: net.rings["ipn:1.0"], delivered, clearingKey: keys.nodeKeys["ipn:1.0"], period });

  // ---- What it all shows ----
  const flows = {};
  for (const tr of traffic) {
    const k = tr.label.replace(/-\d+$/, ""); flows[k] ??= { sent: 0, delivered: 0, latH: [], bytes: tr.bytes, src: tr.src, dst: tr.dst };
    flows[k].sent++;
  }
  for (const d of net.deliveries) { const f = flows[d.label.replace(/-\d+$/, "")]; f.delivered++; f.latH.push((d.deliveredAt - d.created) / H); }
  for (const f of Object.values(flows)) { f.latH.sort((a, b) => a - b); f.medianH = f.latH.length ? +f.latH[Math.floor(f.latH.length / 2)].toFixed(2) : null; f.maxH = f.latH.length ? +f.latH.at(-1).toFixed(2) : null; delete f.latH; }

  const revId = cmp.state.records[0] ? net.recordId(cmp.state.records[0]) : null;
  const propagation = Object.keys(NODES).map((eid) => {
    const seen = revId ? net.firstSeen[eid][revId] : undefined;
    return { node: eid, name: NODES[eid].name, op: NODES[eid].op, heardAfterH: seen === undefined ? null : +((seen - cmp.state.detectAt) / H).toFixed(2) };
  });
  const victimHops = net.deliveries.flatMap((d) => d.path.filter((p) => p.node === victim && p.signed).map((p) => ({ id: d.id, t: p.depart })));
  // Receipts the victim signed with the stolen key after the theft, and which destinations
  // still accepted them because the revocation had not reached them yet.
  const staleKey = (d) => readBlockItems(decodeBundle(d.data)).items.some((it) => {
    const f = receiptFields(it);
    return f.thisHop === victim && f.forwardedAt >= dtn(T) && verify1(it, cmp.state.stolenKey.pub).ok;
  });
  const stale = net.deliveries.filter(staleKey);
  const lateAccepts = stale.filter((d) => d.atDest.ok).map((d) => ({ id: d.id, at: d.deliveredAt }));
  const unsignedByOp = {};
  for (const d of net.deliveries) for (const p of d.path) if (p.signed === false && p.depart) unsignedByOp[NODES[p.node].op] = (unsignedByOp[NODES[p.node].op] || 0) + 1;

  const statementsOk = Object.values(clearing.statements).every((s) => verifyRecord(s).ok);
  const result = {
    period, contacts: contacts.length, signedPlans,
    bundles: { sent: traffic.length, delivered: net.deliveries.length, undelivered: net.undelivered.length },
    flows,
    receipts: net.deliveries.reduce((a, d) => a + readBlockItems(decodeBundle(d.data)).items.length, 0),
    verifiedAtDestination: net.deliveries.filter((d) => d.atDest.ok).length,
    compromise: {
      victim, victimName: NODES[victim].name, stolenAt: new Date(T).toISOString(), detectedAt: new Date(cmp.state.detectAt).toISOString(),
      victimSwitchedKeyAfterH: cmp.state.switchedAt ? +((cmp.state.switchedAt - cmp.state.detectAt) / H).toFixed(2) : null,
      victimSignedHops: victimHops.length,
      staleKeyDeliveries: stale.length,
      honestLoss: clearing.rejected.filter((r) => r.hop === victim && r.reason === "signed_after_revocation" && !forged.some((f) => f.note === r.claim)).length,
      acceptedAtDestinationBeforeTheyHeard: lateAccepts.length,
      propagation,
    },
    forgeries: forged.map((f) => {
      const rs = clearing.rejected.filter((r) => r.claim === f.note);
      return { claim: f.note, outcome: rs.length ? rs.map((r) => r.reason).join(", ") : "earned nothing extra (already credited)" };
    }),
    unsignedHopsByOperator: unsignedByOp,
    settlement: Object.fromEntries(Object.entries(clearing.perOp).filter(([op]) => op !== "science").map(([op, s]) => [op, {
      name: OPERATORS[op].name, bundles: s.bundles, megabytes: +(s.bytes / 1e6).toFixed(3), amount: +s.amount.toFixed(4), rejectedReceipts: s.rejected,
      statement: clearing.statements[op] ? clearing.statements[op].claimId.slice(0, 18) + "..." : null,
    }])),
    statementsVerify: statementsOk,
  };
  return { result, net, contacts, clearing };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { result, net, contacts } = runSSI();
  if (process.argv.includes("--json")) console.log("SSI_RESULT " + JSON.stringify(result));
  else console.log(JSON.stringify(result, null, 1));
  if (process.argv.includes("--write")) {
    const data = {
      result,
      nodes: Object.fromEntries(Object.entries(NODES).map(([e, n]) => [e, { name: n.name, op: n.op, kind: n.kind, custodian: n.custodian }])),
      operators: OPERATORS,
      contacts: contacts.map((c) => ({ from: c.from, to: c.to, start: c.start, end: c.end, owltMs: c.owltMs })),
      bundles: net.deliveries.map((d) => ({ id: d.id, src: d.src, dst: d.dst, created: d.created, delivered: d.deliveredAt, ok: d.atDest.ok, path: d.path.map((p) => ({ node: p.node, arrive: p.arrive, depart: p.depart, signed: p.signed })) })),
      log: net.log,
    };
    writeFileSync(new URL("./explorer-data.json", import.meta.url), JSON.stringify(data));
  }
}
