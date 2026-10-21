// Offline key management (transport/bpv7/keyring.mjs) with receipt v2: a verifier holding
// only its operators' root keys checks custody chains, follows rotation, honours
// revocations that arrive inside ordinary bundles, and refuses backdated signatures from
// stolen keys unless an honest custodian witnessed them in time.
import { test } from "node:test";
import assert from "node:assert/strict";
import { encode } from "../transport/bpv7/cbor.mjs";
import { encodeBundle, decodeBundle, encodeEid, BLOCK, CRC16, CRC32C } from "../transport/bpv7/bundle.mjs";
import { stampBundleV2, verifyBundleV2, readBlockItems } from "../transport/bpv7/receipt-v2.mjs";
import { Keyring, issueKey, revokeKey, carryRecords, ingest, readKeyBlock, keyIdOf, recordFields, ROLE, KEY_BLOCK_TYPE, MAX_BLOCK_RECORDS } from "../transport/bpv7/keyring.mjs";
import { genKeypair } from "../agent/lib/keys.mjs";

const H = 3.6e6, DAY = 24 * H;
const T0 = 846e9; // a DTN time in October 2026 (ms since 2000)

function bundle({ hopCount, previousNode, created = [T0, 1] } = {}) {
  const blocks = [];
  if (previousNode) blocks.push({ type: BLOCK.PREVIOUS_NODE, number: 2, crcType: CRC16, data: encode(encodeEid(previousNode)) });
  if (hopCount !== undefined) blocks.push({ type: BLOCK.HOP_COUNT, number: 3, crcType: CRC32C, data: encode([30, hopCount]) });
  blocks.push({ type: BLOCK.PAYLOAD, number: 1, crcType: CRC32C, data: Buffer.from("science frame ".repeat(40)) });
  return encodeBundle({ primary: { crcType: CRC32C, dest: "ipn:2.1", source: "ipn:5.1", created, lifetime: 30 * DAY }, blocks });
}
const setHopCount = (bytes, n) => {
  const b = decodeBundle(bytes);
  return encodeBundle({ ...b, blocks: b.blocks.map((x) => (x.type === BLOCK.HOP_COUNT ? { ...x, data: encode([30, n]) } : x)) });
};

// One operator: root (anchor) -> issuer (issue + revoke) -> node keys valid for 90 days.
function operator(name, eids) {
  const root = genKeypair(), issuer = genKeypair();
  const issuerRec = issueKey(root, { subject: `${name}:issuer`, pub: issuer.pub, roles: ROLE.ISSUE | ROLE.REVOKE, notBefore: T0 - DAY, notAfter: T0 + 365 * DAY });
  const nodes = {}, records = [issuerRec];
  for (const eid of eids) {
    const kp = genKeypair();
    nodes[eid] = { kp, eid };
    records.push(issueKey(issuer, { subject: eid, pub: kp.pub, notBefore: T0 - DAY, notAfter: T0 + 90 * DAY }));
  }
  return { name, root, issuer, nodes, records, anchor: { name, pub: root.pub } };
}

// Stamp a path: each custodian adds a receipt (with chain digest) and carries key records.
function path(bytes, steps, records) {
  let out = carryRecords(bytes, records);
  for (const s of steps) {
    out = stampBundleV2(out, s.node, { prevHop: s.prev, receivedAt: s.at, forwardedAt: s.at + 1000, chain: true, hops: true });
  }
  return out;
}

test("keyring: a verifier with only the root key verifies a chain whose key records ride in block 225", () => {
  const op = operator("dsn", ["ipn:20.0", "ipn:30.0"]);
  const out = path(bundle(), [
    { node: op.nodes["ipn:20.0"], prev: "ipn:5.0", at: T0 },
    { node: op.nodes["ipn:30.0"], prev: "ipn:20.0", at: T0 + H },
  ], op.records);
  assert.equal(readKeyBlock(decodeBundle(out)).length, 3);
  const ring = new Keyring({ anchors: [op.anchor] });
  assert.equal(ingest(ring, out, T0 + 2 * H), 3);
  const v = verifyBundleV2(out, { keyring: ring, origin: "ipn:5.0", lastNode: "ipn:30.0", arrivedAt: T0 + 2 * H });
  assert.equal(v.ok, true, v.reason);
  assert.equal(v.complete, true);
  assert.equal(v.keys.length, 2);
  // Without the anchor, the same records prove nothing.
  const stranger = new Keyring({ anchors: [operator("other", []).anchor] });
  ingest(stranger, out, T0 + 2 * H);
  assert.equal(verifyBundleV2(out, { keyring: stranger }).reason, "chain_not_anchored");
});

test("keyring: unknown, self-issued, wrong-role and expired keys are refused", () => {
  const op = operator("dsn", ["ipn:20.0"]);
  const ring = () => { const r = new Keyring({ anchors: [op.anchor] }); for (const x of op.records) r.add(x, T0); return r; };
  const n = op.nodes["ipn:20.0"];
  const one = (node, at, records = []) => path(bundle(), [{ node, prev: "ipn:5.0", at }], records);
  // A node nobody issued a key to.
  assert.equal(verifyBundleV2(one({ kp: genKeypair(), eid: "ipn:99.0" }, T0), { keyring: ring() }).reason, "custodian_key_unknown");
  // An attacker issues its own key for ipn:20.0 and carries the record.
  const evil = genKeypair(), evilKey = genKeypair();
  const forged = one({ kp: evilKey, eid: "ipn:20.0" }, T0, [issueKey(evil, { subject: "ipn:20.0", pub: evilKey.pub, notBefore: T0 - DAY, notAfter: T0 + DAY })]);
  const r1 = ring(); ingest(r1, forged, T0);
  assert.equal(verifyBundleV2(forged, { keyring: r1 }).reason, "chain_not_anchored"); // the forged key verifies the signature but chains to no anchor
  // The issuer's key (issue role, no custody role) signing a receipt.
  const r2 = ring();
  const asIssuer = one({ kp: op.issuer, eid: "dsn:issuer" }, T0);
  assert.equal(verifyBundleV2(asIssuer, { keyring: r2 }).reason, "key_lacks_role");
  // Expired: signed after notAfter.
  assert.equal(verifyBundleV2(one(n, T0 + 91 * DAY), { keyring: ring() }).reason, "key_expired");
  assert.equal(verifyBundleV2(one(n, T0 - 2 * DAY), { keyring: ring() }).reason, "key_not_yet_valid");
});

test("keyring: rotation: old and new keys each verify inside their own windows", () => {
  const op = operator("dsn", ["ipn:20.0"]);
  const oldKp = op.nodes["ipn:20.0"].kp, newKp = genKeypair();
  const rot = issueKey(op.issuer, { subject: "ipn:20.0", pub: newKp.pub, notBefore: T0 + 60 * DAY, notAfter: T0 + 150 * DAY, replaces: oldKp.pub });
  const ring = new Keyring({ anchors: [op.anchor] });
  for (const x of [...op.records, rot]) ring.add(x, T0);
  const at = (kp, t) => path(bundle(), [{ node: { kp, eid: "ipn:20.0" }, prev: "ipn:5.0", at: t }], []);
  assert.equal(verifyBundleV2(at(oldKp, T0 + 10 * DAY), { keyring: ring }).ok, true);
  assert.equal(verifyBundleV2(at(newKp, T0 + 100 * DAY), { keyring: ring }).ok, true);
  assert.equal(verifyBundleV2(at(oldKp, T0 + 100 * DAY), { keyring: ring }).reason, "key_expired");
  assert.equal(verifyBundleV2(at(newKp, T0 + 10 * DAY), { keyring: ring }).reason, "key_not_yet_valid");
});

test("keyring: a stolen key cannot sign after the revocation, nor backdate without a witness", () => {
  const op = operator("dsn", ["ipn:20.0", "ipn:30.0"]);
  const R = op.nodes["ipn:20.0"], D = op.nodes["ipn:30.0"];
  const Tc = T0 + 10 * DAY; // the key may have been taken from here on
  const rev = revokeKey(op.issuer, { target: R.kp.pub, effectiveFrom: Tc, issuedAt: Tc + DAY });
  const ring = new Keyring({ anchors: [op.anchor] });
  for (const x of [...op.records, rev]) ring.add(x, Tc + DAY);

  // a) The thief signs with the true time, after the compromise.
  const late = path(bundle(), [{ node: R, prev: "ipn:5.0", at: Tc + 2 * DAY }], []);
  assert.equal(verifyBundleV2(late, { keyring: ring }).reason, "signed_after_revocation");

  // b) The thief backdates to before the compromise; nothing honest saw it in time.
  const backdated = path(bundle(), [{ node: R, prev: "ipn:5.0", at: Tc - DAY }], []);
  assert.equal(verifyBundleV2(backdated, { keyring: ring, arrivedAt: Tc + 3 * DAY }).reason, "revoked_unwitnessed");

  // c) An honest receipt from before the compromise, witnessed by D's receipt (field 9
  //    commits to it) received before the compromise: still valid.
  const honest = path(bundle(), [
    { node: R, prev: "ipn:5.0", at: Tc - 2 * DAY },
    { node: D, prev: "ipn:20.0", at: Tc - DAY },
  ], []);
  const v = verifyBundleV2(honest, { keyring: ring, arrivedAt: Tc + 3 * DAY });
  assert.equal(v.ok, true, v.reason);
  assert.deepEqual(v.witnessed[0].witnessedBy, { hop: 1, eid: "ipn:30.0" });

  // d) Witnessed by the verifier's own arrival time instead.
  assert.equal(verifyBundleV2(backdated, { keyring: ring, arrivedAt: Tc - 1000 }).ok, true);

  // e) The thief slips a backdated receipt in ahead of D's: D's chain digest no longer matches.
  const items = readBlockItems(decodeBundle(honest)).items;
  const fake = readBlockItems(decodeBundle(path(bundle(), [{ node: R, prev: "ipn:5.0", at: Tc - 3 * DAY }], []))).items[0];
  const b = decodeBundle(honest);
  const spliced = encodeBundle({ ...b, blocks: b.blocks.map((x) => (x.type === 224 ? { ...x, data: encode([fake, ...items]) } : x)) });
  assert.equal(verifyBundleV2(spliced, { keyring: ring, arrivedAt: Tc + 3 * DAY }).reason, "chain_digest_mismatch");
});

test("keyring: self-revocation counts; a revocation from another operator's key does not", () => {
  const a = operator("dsn", ["ipn:20.0"]), b = operator("esa", ["ipn:40.0"]);
  const R = a.nodes["ipn:20.0"];
  const Tc = T0 + 5 * DAY;
  const signed = path(bundle(), [{ node: R, prev: "ipn:5.0", at: Tc + DAY }], []);
  const ring = (extra) => { const r = new Keyring({ anchors: [a.anchor, b.anchor] }); for (const x of [...a.records, ...b.records, ...extra]) r.add(x, T0); return r; };
  // Another operator's node key tries to revoke ours: ignored.
  const hostile = revokeKey(b.nodes["ipn:40.0"].kp, { target: R.kp.pub, effectiveFrom: T0 });
  assert.equal(verifyBundleV2(signed, { keyring: ring([hostile]) }).ok, true);
  // The node revokes itself (it knows it was tampered with): honoured, no operator needed.
  const self = revokeKey(R.kp, { target: R.kp.pub, effectiveFrom: Tc, reason: "tamper switch" });
  assert.equal(verifyBundleV2(signed, { keyring: ring([self]) }).reason, "signed_after_revocation");
  // The other operator's root (an anchor) may revoke: anchors are trusted to.
  const byAnchor = revokeKey(b.root, { target: R.kp.pub, effectiveFrom: Tc });
  assert.equal(verifyBundleV2(signed, { keyring: ring([byAnchor]) }).reason, "signed_after_revocation");
});

test("keyring: when an issuer is revoked, keys it issued count only if held before the compromise", () => {
  const op = operator("dsn", ["ipn:20.0"]);
  const Tc = T0 + 20 * DAY;
  const revIssuer = revokeKey(op.root, { target: op.issuer.pub, effectiveFrom: Tc });
  // The thief issues a new key for ipn:20.0, backdating issuedAt.
  const thiefKp = genKeypair();
  const thiefRec = issueKey(op.issuer, { subject: "ipn:20.0", pub: thiefKp.pub, notBefore: T0, notAfter: T0 + 90 * DAY, issuedAt: T0 });
  const ring = new Keyring({ anchors: [op.anchor] });
  for (const x of op.records) ring.add(x, T0);          // held long before
  ring.add(revIssuer, Tc + DAY);
  ring.add(thiefRec, Tc + 2 * DAY);                      // first seen after the compromise
  const genuine = path(bundle(), [{ node: op.nodes["ipn:20.0"], prev: "ipn:5.0", at: T0 + 30 * DAY }], []);
  const thief = path(bundle(), [{ node: { kp: thiefKp, eid: "ipn:20.0" }, prev: "ipn:5.0", at: T0 + 30 * DAY }], []);
  assert.equal(verifyBundleV2(genuine, { keyring: ring }).ok, true);
  assert.equal(verifyBundleV2(thief, { keyring: ring }).reason, "issuer_revoked");
});

test("keyring: revocations spread with ordinary traffic, revocations first, capped", () => {
  const op = operator("dsn", ["ipn:20.0", "ipn:30.0"]);
  const R = op.nodes["ipn:20.0"];
  const Tc = T0 + DAY;
  const rev = revokeKey(op.issuer, { target: R.kp.pub, effectiveFrom: Tc });
  // A custodian that knows the revocation adds it to an unrelated bundle it handles.
  const carrier = new Keyring({ anchors: [op.anchor] });
  for (const x of [...op.records, rev]) carrier.add(x, Tc);
  const other = carryRecords(bundle({ created: [T0, 9] }), carrier.forCarriage([keyIdOf(op.nodes["ipn:30.0"].kp.pub).toString("hex")]));
  const carried = readKeyBlock(decodeBundle(other));
  assert.equal(carried.length, 3); // the revocation, the node's key, its issuer's key (anchors never travel)
  assert.equal(recordFields(carried[0]).kind, 2);
  assert.equal(decodeBundle(other).blocks.filter((x) => x.type === KEY_BLOCK_TYPE).length, 1);
  // The verifier learns of it from that bundle, then refuses R's later signature.
  const ring = new Keyring({ anchors: [op.anchor] });
  for (const x of op.records) ring.add(x, T0);
  const signed = path(bundle(), [{ node: R, prev: "ipn:5.0", at: Tc + H }], []);
  assert.equal(verifyBundleV2(signed, { keyring: ring }).ok, true);
  ingest(ring, other, Tc + 2 * H);
  assert.equal(verifyBundleV2(signed, { keyring: ring }).reason, "signed_after_revocation");
  // The block never grows past its cap.
  let big = bundle();
  for (let i = 0; i < 3; i++) big = carryRecords(big, Array.from({ length: 20 }, () => revokeKey(genKeypair(), { target: genKeypair().pub, effectiveFrom: T0 })));
  assert.equal(readKeyBlock(decodeBundle(big)).length, MAX_BLOCK_RECORDS);
});

test("receipt field 8: hop counts size the unsigned gap; field 9 is optional and checked", () => {
  const op = operator("dsn", ["ipn:20.0", "ipn:30.0"]);
  const ring = new Keyring({ anchors: [op.anchor] });
  for (const x of op.records) ring.add(x, T0);
  let b = stampBundleV2(bundle({ hopCount: 0 }), op.nodes["ipn:20.0"], { prevHop: "ipn:5.0", receivedAt: T0, forwardedAt: T0 + 1, hops: true, chain: true });
  b = setHopCount(b, 3); // three plain BPv7 forwarders, each adding 1
  b = stampBundleV2(b, op.nodes["ipn:30.0"], { prevHop: "ipn:12.0", receivedAt: T0 + H, forwardedAt: T0 + H + 1, hops: true, chain: true });
  const v = verifyBundleV2(b, { keyring: ring, origin: "ipn:5.0", lastNode: "ipn:30.0" });
  assert.equal(v.ok, true, v.reason);
  assert.deepEqual(v.gaps, [{ afterHop: "ipn:20.0", beforeHop: "ipn:30.0", lastUnsigned: "ipn:12.0", unsignedNodes: 3 }]);
  // A custodian that names its predecessor while the count says otherwise is caught too.
  let c = stampBundleV2(bundle({ hopCount: 0 }), op.nodes["ipn:20.0"], { prevHop: "ipn:5.0", receivedAt: T0, forwardedAt: T0 + 1, hops: true });
  c = setHopCount(c, 2);
  c = stampBundleV2(c, op.nodes["ipn:30.0"], { prevHop: "ipn:20.0", receivedAt: T0 + H, forwardedAt: T0 + H + 1, hops: true });
  assert.deepEqual(verifyBundleV2(c, { keyring: ring, origin: "ipn:5.0", lastNode: "ipn:30.0" }).gaps, [{ afterHop: "ipn:20.0", beforeHop: "ipn:30.0", lastUnsigned: null, unsignedNodes: 2 }]);
});
