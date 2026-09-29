// Ground-side pilot kit: custody records produced entirely at a ground station, from
// data it has already received. No flight software changes. The station signs what it
// received (a manifest over the file's chunks plus a custody receipt naming the
// spacecraft as the previous hop), reports every scheduled pass (nominal, partial or
// silent), turns a silent pass into a gap, and seals the whole ledger under one root
// that can be timestamped or compared with another station.
import { createHash } from "node:crypto";
import { leafHash, buildTree } from "../agent/lib/merkle.mjs";
import { contentId } from "../agent/lib/canonical.mjs";
import { signRecord, verifyRecord, buildManifest, custodyReceipt } from "../agent/lib/receipt.mjs";
import { gapObject } from "../agent/lib/gap.mjs";

const sha256 = (b) => createHash("sha256").update(b).digest("hex");
const ms = (t) => (typeof t === "number" ? t : Date.parse(t));

// Fingerprint one received product: chunk leaves, Merkle root and whole-file hash.
export function fingerprint(bytes, chunkSize = 65536) {
  const leaves = [];
  for (let i = 0; i < bytes.length; i += chunkSize) leaves.push(leafHash(bytes.subarray(i, i + chunkSize)));
  if (leaves.length === 0) leaves.push(leafHash(Buffer.alloc(0)));
  return { root: buildTree(leaves).root, chunkCount: leaves.length, sha256: sha256(bytes), bytes: bytes.length, chunkSize };
}

// Which scheduled pass a reception time falls in (inclusive), or null.
export function passFor(passes, t) {
  return passes.find((p) => t >= ms(p.start) && t <= ms(p.end)) || null;
}

// Build the station's signed ledger.
//   files:  [{ name, bytes (Buffer), receivedAt (ms) }]
//   passes: [{ passId, start, end }] from the operator's schedule (ISO or epoch ms)
export function buildLedger(kp, { station, spacecraft, files, passes, chunkSize = 65536 }) {
  const records = [];
  const sorted = [...files].sort((a, b) => a.receivedAt - b.receivedAt || a.name.localeCompare(b.name));
  const byPass = new Map(passes.map((p) => [p.passId, []]));
  const unscheduled = [];

  for (const f of sorted) {
    const fp = fingerprint(f.bytes, chunkSize);
    const pass = passFor(passes, f.receivedAt);
    const payloadId = contentId({ station, sha256: fp.sha256, name: f.name });
    const manifest = signRecord(kp, buildManifest({
      payloadId, chunkCount: fp.chunkCount, root: fp.root,
      meta: { observedBy: station, name: f.name, bytes: fp.bytes, sha256: fp.sha256, chunkSize, passId: pass ? pass.passId : null },
    }));
    const receipt = custodyReceipt(kp, {
      payloadId, bundleId: manifest.claimId, prevHop: spacecraft, thisHop: station,
      receivedAt: f.receivedAt, forwardedAt: f.receivedAt,
    });
    records.push(manifest, receipt);
    (pass ? byPass.get(pass.passId) : unscheduled).push({ name: f.name, receivedAt: f.receivedAt, payloadId });
  }

  // One report per scheduled pass. A pass with no data becomes a gap that runs from the
  // scheduled start until data next arrived at this station (null if it has not yet).
  for (const p of [...passes].sort((a, b) => ms(a.start) - ms(b.start))) {
    const got = byPass.get(p.passId);
    const status = got.length === 0 ? "no-data" : "received";
    const report = {
      kind: "station.pass/1", station, spacecraft, passId: p.passId,
      scheduledStart: ms(p.start), scheduledEnd: ms(p.end),
      products: got.length, firstAt: got[0]?.receivedAt ?? null, lastAt: got.at(-1)?.receivedAt ?? null,
      payloadIds: got.map((g) => g.payloadId), status,
    };
    if (status === "no-data") {
      const next = sorted.find((f) => f.receivedAt > ms(p.end));
      const events = [{ link: `${spacecraft}>${station}`, event: "down", t: ms(p.start) }];
      if (next) events.push({ link: `${spacecraft}>${station}`, event: "up", t: next.receivedAt });
      report.gap = { ...gapObject({ link: `${spacecraft}>${station}`, linkEvents: events }), note: "scheduled pass produced no data at this station; gap runs until data next arrived." };
    }
    records.push(signRecord(kp, report));
  }
  if (unscheduled.length) {
    records.push(signRecord(kp, { kind: "station.unscheduled/1", station, spacecraft, products: unscheduled.map((u) => ({ name: u.name, receivedAt: u.receivedAt, payloadId: u.payloadId })) }));
  }

  // Seal: a Merkle root over every record id, signed. This single 32-byte value is what
  // an operator may timestamp publicly; nothing else leaves the station.
  const tree = buildTree(records.map((r) => r.claimId.slice(2)));
  const seal = signRecord(kp, { kind: "station.ledger/1", station, spacecraft, recordCount: records.length, root: tree.root });
  return { station, spacecraft, stationPub: kp.pub, records, seal };
}

// Verify a ledger under the PINNED station key (never the key the ledger carries).
// Optionally re-hash the products on disk (map name -> Buffer) to prove none changed.
export function verifyLedger(ledger, { stationPub, files } = {}) {
  const fail = (reason, extra = {}) => ({ ok: false, reason, ...extra });
  if (!stationPub) return fail("unpinned: verifier must supply the station public key");
  const all = [...ledger.records, ledger.seal];
  for (const r of all) {
    const v = verifyRecord(r);
    if (!v.ok) return fail(v.reason, { claimId: r.claimId });
    if (v.signer !== stationPub) return fail("signer_not_pinned_station_key", { claimId: r.claimId });
  }
  const root = buildTree(ledger.records.map((r) => r.claimId.slice(2))).root;
  if (root !== ledger.seal.root || ledger.seal.recordCount !== ledger.records.length) return fail("seal_mismatch");
  let checked = 0;
  if (files) {
    for (const m of ledger.records.filter((r) => r.kind === "manifest/1")) {
      const b = files.get(m.meta.name);
      if (!b) return fail("product_missing", { name: m.meta.name });
      const fp = fingerprint(b, m.meta.chunkSize);
      if (fp.root !== m.root || fp.sha256 !== m.meta.sha256) return fail("product_altered", { name: m.meta.name });
      checked++;
    }
  }
  const passes = ledger.records.filter((r) => r.kind === "station.pass/1");
  return {
    ok: true, records: ledger.records.length, products: ledger.records.filter((r) => r.kind === "manifest/1").length,
    productsRehashed: checked, passes: passes.length, silentPasses: passes.filter((p) => p.status === "no-data").length, sealRoot: ledger.seal.root,
  };
}

// Compare two stations' verified ledgers: identical products (same whole-file hash and
// Merkle root) received by both are corroborated; the rest are single-station.
export function corroborate(a, b) {
  const key = (m) => `${m.meta.sha256}:${m.root}`;
  const mA = new Map(a.records.filter((r) => r.kind === "manifest/1").map((m) => [key(m), m]));
  const mB = new Map(b.records.filter((r) => r.kind === "manifest/1").map((m) => [key(m), m]));
  const both = [...mA.keys()].filter((k) => mB.has(k)).map((k) => ({ sha256: k.split(":")[0], name: mA.get(k).meta.name }));
  return {
    corroborated: both,
    onlyA: [...mA.keys()].filter((k) => !mB.has(k)).map((k) => mA.get(k).meta.name),
    onlyB: [...mB.keys()].filter((k) => !mA.has(k)).map((k) => mB.get(k).meta.name),
  };
}
