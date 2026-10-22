// Scenarios for the onboard keyring (flight/keyring.c), answered by the reference keyring
// (transport/bpv7/keyring.mjs). Writes the scenario lines for kr_check to <out.txt> and the
// reference answers to <expected.json>. Usage: node flight/keyring-vectors.mjs out.txt expected.json
import { writeFileSync } from "node:fs";
import { encode } from "../transport/bpv7/cbor.mjs";
import { encodeBundle, decodeBundle, BLOCK, CRC32C } from "../transport/bpv7/bundle.mjs";
import { Keyring, issueKey, revokeKey, carryRecords, rawPub, keyIdOf, ROLE, KEY_BLOCK_TYPE } from "../transport/bpv7/keyring.mjs";
import { genKeypair } from "../agent/lib/keys.mjs";

const [outPath, expPath] = process.argv.slice(2);
const DAY = 864e5, T0 = 846e9;
const lines = [], expected = {};
const hexPub = (pub) => rawPub(pub).toString("hex");
const hexItem = (item) => encode(item).toString("hex");

let ring;
function scenario(skew = 0) { ring = new Keyring({ skewMs: skew }); lines.push(`N ${skew}`); }
function anchor(pub) { ring.anchors.set(keyIdOf(pub).toString("hex"), { name: "anchor", pub }); lines.push(`A ${hexPub(pub)} -`); }
function record(item, seen) { ring.add(item, seen); lines.push(`R ${seen} ${hexItem(item)}`); }
function block(items, seen) {
  let b = encodeBundle({ primary: { crcType: CRC32C, dest: "ipn:2.1", source: "ipn:5.1", created: [T0, 1], lifetime: DAY }, blocks: [{ type: BLOCK.PAYLOAD, number: 1, crcType: CRC32C, data: Buffer.from("x") }] });
  b = carryRecords(b, items);
  const data = decodeBundle(b).blocks.find((x) => x.type === KEY_BLOCK_TYPE).data;
  for (const it of items) ring.add(it, seen);
  lines.push(`B ${seen} ${Buffer.from(data).toString("hex")}`);
}
function query(name, pub, eid, t, role = ROLE.CUSTODY) {
  const s = ring.status(pub, eid, t, role);
  expected[name] = s.ok ? { ok: 1, reason: "ok", revokedFrom: s.revokedFrom ?? null } : { ok: 0, reason: s.reason, revokedFrom: null };
  lines.push(`Q ${name} ${hexPub(pub)} ${eid} ${t} ${role}`);
}
function operator(eids) {
  const root = genKeypair(), issuer = genKeypair(), nodes = {};
  const recs = [issueKey(root, { subject: "op:issuer", pub: issuer.pub, roles: ROLE.ISSUE | ROLE.REVOKE, notBefore: T0 - DAY, notAfter: T0 + 365 * DAY })];
  for (const e of eids) { nodes[e] = genKeypair(); recs.push(issueKey(issuer, { subject: e, pub: nodes[e].pub, notBefore: T0 - DAY, notAfter: T0 + 90 * DAY })); }
  return { root, issuer, nodes, recs };
}

// 1. Basics: valid, window edges, wrong node, wrong role, unknown key.
{ const op = operator(["ipn:20.0", "ipn:30.0"]); scenario(); anchor(op.root.pub); op.recs.forEach((r) => record(r, T0));
  const a = op.nodes["ipn:20.0"].pub;
  query("valid", a, "ipn:20.0", T0); query("valid_other", op.nodes["ipn:30.0"].pub, "ipn:30.0", T0 + DAY);
  query("expired", a, "ipn:20.0", T0 + 91 * DAY); query("not_yet", a, "ipn:20.0", T0 - 2 * DAY);
  query("last_ms", a, "ipn:20.0", T0 + 90 * DAY); query("wrong_node", a, "ipn:30.0", T0);
  query("issuer_as_custody", op.issuer.pub, "op:issuer", T0); query("issuer_as_issue", op.issuer.pub, "op:issuer", T0, ROLE.ISSUE);
  query("unknown", genKeypair().pub, "ipn:20.0", T0); query("root_as_node", op.root.pub, "ipn:20.0", T0); }
// 2. Skew allowance.
{ const op = operator(["ipn:20.0"]); scenario(60000); anchor(op.root.pub); op.recs.forEach((r) => record(r, T0));
  const a = op.nodes["ipn:20.0"].pub;
  query("skew_inside", a, "ipn:20.0", T0 - DAY - 30000); query("skew_outside", a, "ipn:20.0", T0 - DAY - 90000); }
// 3. Self-issued key, out-of-order arrival, tampered signature, issuer without issue role.
{ const op = operator(["ipn:20.0"]); scenario(); anchor(op.root.pub);
  const evil = genKeypair(), evilKey = genKeypair();
  record(issueKey(evil, { subject: "ipn:20.0", pub: evilKey.pub, notBefore: T0 - DAY, notAfter: T0 + DAY }), T0);
  record(op.recs[1], T0); record(op.recs[0], T0 + 1); // node record before its issuer's
  const n2 = genKeypair(), bad = issueKey(op.issuer, { subject: "ipn:21.0", pub: n2.pub, notBefore: T0 - DAY, notAfter: T0 + DAY });
  bad[3] = Buffer.from(bad[3]); bad[3][0] ^= 1; record(bad, T0);
  const sub = genKeypair(); record(issueKey(op.nodes["ipn:20.0"], { subject: "ipn:22.0", pub: sub.pub, notBefore: T0 - DAY, notAfter: T0 + DAY }), T0);
  query("self_issued", evilKey.pub, "ipn:20.0", T0); query("out_of_order", op.nodes["ipn:20.0"].pub, "ipn:20.0", T0);
  query("bad_signature", n2.pub, "ipn:21.0", T0); query("issuer_lacks_role", sub.pub, "ipn:22.0", T0); }
// 4. Issuer not valid at issuance; rotation.
{ const root = genKeypair(), iss = genKeypair(); scenario(); anchor(root.pub);
  record(issueKey(root, { subject: "op:issuer", pub: iss.pub, roles: ROLE.ISSUE, notBefore: T0, notAfter: T0 + 10 * DAY }), T0);
  const late = genKeypair(), oldK = genKeypair(), newK = genKeypair();
  record(issueKey(iss, { subject: "ipn:20.0", pub: late.pub, notBefore: T0, notAfter: T0 + 90 * DAY, issuedAt: T0 + 20 * DAY }), T0);
  record(issueKey(iss, { subject: "ipn:21.0", pub: oldK.pub, notBefore: T0, notAfter: T0 + 60 * DAY, issuedAt: T0 + DAY }), T0);
  record(issueKey(iss, { subject: "ipn:21.0", pub: newK.pub, notBefore: T0 + 50 * DAY, notAfter: T0 + 150 * DAY, issuedAt: T0 + 2 * DAY, replaces: oldK.pub }), T0);
  query("issued_outside_issuer_window", late.pub, "ipn:20.0", T0 + 30 * DAY);
  query("rot_old_inside", oldK.pub, "ipn:21.0", T0 + 10 * DAY); query("rot_new_inside", newK.pub, "ipn:21.0", T0 + 100 * DAY);
  query("rot_old_after", oldK.pub, "ipn:21.0", T0 + 100 * DAY); query("rot_new_before", newK.pub, "ipn:21.0", T0 + 10 * DAY); }
// 5. Revocations: by issuer, earliest wins, self, hostile, other anchor, revoke-role key.
{ const a = operator(["ipn:20.0", "ipn:21.0", "ipn:22.0"]), b = operator(["ipn:40.0"]); scenario(); anchor(a.root.pub); anchor(b.root.pub);
  [...a.recs, ...b.recs].forEach((r) => record(r, T0));
  const n20 = a.nodes["ipn:20.0"], n21 = a.nodes["ipn:21.0"], n22 = a.nodes["ipn:22.0"];
  record(revokeKey(a.issuer, { target: n20.pub, effectiveFrom: T0 + 10 * DAY }), T0 + 11 * DAY);
  record(revokeKey(n20, { target: n20.pub, effectiveFrom: T0 + 8 * DAY }), T0 + 11 * DAY);
  record(revokeKey(b.nodes["ipn:40.0"], { target: n21.pub, effectiveFrom: T0 }), T0);
  record(revokeKey(b.root, { target: n22.pub, effectiveFrom: T0 + 5 * DAY }), T0);
  const revoker = genKeypair(); record(issueKey(a.root, { subject: "op:revoker", pub: revoker.pub, roles: ROLE.REVOKE, notBefore: T0 - DAY, notAfter: T0 + 365 * DAY }), T0);
  const n23 = genKeypair(); record(issueKey(a.issuer, { subject: "ipn:23.0", pub: n23.pub, notBefore: T0 - DAY, notAfter: T0 + 90 * DAY }), T0);
  record(revokeKey(revoker, { target: n23.pub, effectiveFrom: T0 + 3 * DAY }), T0);
  const n41 = genKeypair(); record(issueKey(b.issuer, { subject: "ipn:41.0", pub: n41.pub, notBefore: T0 - DAY, notAfter: T0 + 90 * DAY }), T0);
  record(revokeKey(revoker, { target: n41.pub, effectiveFrom: T0 + 3 * DAY }), T0); // other operator's node: not allowed
  query("rev_earliest_wins", n20.pub, "ipn:20.0", T0 + DAY); query("rev_hostile_ignored", n21.pub, "ipn:21.0", T0 + DAY);
  query("rev_other_anchor", n22.pub, "ipn:22.0", T0 + DAY); query("rev_role_same_anchor", n23.pub, "ipn:23.0", T0 + DAY);
  query("rev_role_other_anchor", n41.pub, "ipn:41.0", T0 + DAY); }
// 6. Issuer compromise: records first seen after it no longer count.
{ const op = operator(["ipn:20.0"]); scenario(); anchor(op.root.pub); op.recs.forEach((r) => record(r, T0));
  const Tc = T0 + 20 * DAY, thief = genKeypair();
  record(revokeKey(op.root, { target: op.issuer.pub, effectiveFrom: Tc }), Tc + DAY);
  record(issueKey(op.issuer, { subject: "ipn:20.0", pub: thief.pub, notBefore: T0, notAfter: T0 + 90 * DAY, issuedAt: T0 }), Tc + 2 * DAY);
  query("issuer_compromise_genuine", op.nodes["ipn:20.0"].pub, "ipn:20.0", T0 + 30 * DAY);
  query("issuer_compromise_thief", thief.pub, "ipn:20.0", T0 + 30 * DAY); }
// 7. In-band: a Key Record Block carries the issuer, node key and a revocation; duplicates collapse.
{ const op = operator(["ipn:20.0", "ipn:30.0"]); scenario(); anchor(op.root.pub);
  const rev = revokeKey(op.issuer, { target: op.nodes["ipn:30.0"].pub, effectiveFrom: T0 + 2 * DAY });
  block([...op.recs, rev], T0); block([op.recs[1]], T0 + DAY);
  query("block_valid", op.nodes["ipn:20.0"].pub, "ipn:20.0", T0 + DAY);
  query("block_revoked", op.nodes["ipn:30.0"].pub, "ipn:30.0", T0 + DAY); }

writeFileSync(outPath, lines.join("\n") + "\n");
writeFileSync(expPath, JSON.stringify(expected, null, 1));
console.log(`[keyring] ${Object.keys(expected).length} queries in ${lines.filter((l) => l[0] === "N").length} scenarios`);
