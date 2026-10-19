// The three roles of a relief network, independent of transport and storage.
//
//   clinic: seals a file to the hub, chunks it, signs the manifest, sends it to its next hop.
//   relay:  courier phones and satellite relays. Signs a custody receipt for every chunk it
//           takes, appends it to the frame and forwards to its next hop. Keeps a claims log.
//   hub:    collects manifests and chunks, and once a report is complete checks the clinic's
//           signature, every chunk against the root, and every custody receipt against the
//           pinned relay keys; then decrypts it. Holds and transit times come from the signed
//           receipt timestamps. Pays only for receipts that verified.
//
// Frames are JSON: { v: 1, kind: "manifest", manifest } and
// { v: 1, kind: "chunk", bundle, custody: [receipts], lastHop }.
import { prepare } from "../../../agent/source.mjs";
import { makeRelay } from "../../../agent/relay.mjs";
import { makeDest } from "../../../agent/dest.mjs";
import { auditCustodyChain } from "../../../agent/lib/receipt.mjs";
import { sealTo, openAt } from "./seal.mjs";

export const FRAME_V = 1;
const enc = (o) => Buffer.from(JSON.stringify(o), "utf8");
const dec = (b) => { try { const f = JSON.parse(Buffer.from(b).toString("utf8")); return f && f.v === FRAME_V ? f : null; } catch { return null; } };

// Sealed file layout: [4 byte header length][header JSON][raw file bytes]. Raw bytes, not
// base64, so nothing is added to what crosses the satellite link.
export function packFile(header, bytes) {
  const h = Buffer.from(JSON.stringify(header), "utf8");
  const len = Buffer.alloc(4); len.writeUInt32BE(h.length);
  return Buffer.concat([len, h, bytes]);
}
export function unpackFile(buf) {
  const n = buf.readUInt32BE(0);
  if (n > buf.length - 4) throw new Error("bad file header");
  return { header: JSON.parse(buf.subarray(4, 4 + n).toString("utf8")), bytes: buf.subarray(4 + n) };
}

// ---- clinic ------------------------------------------------------------------------------
export function makeClinic({ kp, eid, next, hubEncPub, chunkSize = 1024, now = Date.now }) {
  let seq = 0;
  return {
    // file: { name, type?, bytes: Buffer }. Returns { payloadId, root, chunks }.
    async sendFile(transport, file) {
      const createdAt = now();
      const payloadId = `${eid.replace(/^dtn:\/\//, "").replace(/\/$/, "")}/${createdAt}-${seq++}`;
      const inner = packFile({ name: file.name, type: file.type || null, createdAt }, file.bytes);
      const sealed = sealTo(hubEncPub, inner, payloadId);
      const { manifest, bundles } = prepare(kp, sealed, { payloadId, chunkSize, meta: { clinic: eid, createdAt } });
      await transport.send(next, enc({ v: FRAME_V, kind: "manifest", manifest }));
      for (const bundle of bundles) await transport.send(next, enc({ v: FRAME_V, kind: "chunk", bundle, custody: [], lastHop: eid }));
      return { payloadId, root: manifest.root, chunks: bundles.length };
    },
  };
}

// ---- relay (courier or satellite relay) ----------------------------------------------------
export function makeRelayNode({ kp, eid, next, now = Date.now, onClaim = () => {} }) {
  const relay = makeRelay(kp, eid);
  let forwarded = 0;
  return {
    get forwarded() { return forwarded; },
    async onFrame(transport, buf) {
      const f = dec(buf);
      if (!f) return;
      if (f.kind === "chunk" && f.bundle && Array.isArray(f.custody)) {
        const t = now();
        const receipt = relay.stamp(f.bundle, f.lastHop, t, t);
        f.custody.push(receipt);
        f.lastHop = eid;
        onClaim({ payloadId: f.bundle.payloadId, bundleId: f.bundle.bundleId, claimId: receipt.claimId, at: t });
      }
      await transport.send(next, enc(f));
      forwarded++;
    },
  };
}

// ---- hub -------------------------------------------------------------------------------------
// directory: { clinics: { eid: signPub }, relays: { eid: signPub } }
export function makeHub({ kp, eid, encPriv, directory, ratePerBundleSats = 50, holdThresholdMs = 10 * 60_000, now = Date.now }) {
  const payloads = new Map(); // payloadId -> { manifest, dest, clinic, chunks: Map(index -> { bundle, custody, arrivedAt, ok }), report }
  const refusals = [];
  const paid = new Map();     // relayEid -> Set(bundleId) with verified custody
  let duplicates = 0;

  const refuse = (r) => { refusals.push({ at: now(), ...r }); };
  const entry = (id) => { if (!payloads.has(id)) payloads.set(id, { manifest: null, chunks: new Map(), report: null }); return payloads.get(id); };

  // Check a stored chunk; a bad one is dropped (and refused) so a good copy can still arrive.
  function check(id, p, index) {
    const c = p.chunks.get(index);
    const r = p.dest.receiveBundle(c.bundle);
    if (!r.ok) { p.chunks.delete(index); refuse({ payloadId: id, index, reason: r.reason }); return; }
    const a = auditCustodyChain(c.custody, { bundleId: c.bundle.bundleId, keys: directory.relays, origin: p.clinic });
    if (!a.ok) { p.chunks.delete(index); refuse({ payloadId: id, index, reason: a.reason, hop: a.hop, claimedBy: c.custody[a.hop]?.thisHop }); return; }
    if (!a.complete) { p.chunks.delete(index); refuse({ payloadId: id, index, reason: "uncustodied_gap", gaps: a.gaps }); return; }
    c.ok = true;
    for (const rec of c.custody) {
      if (!paid.has(rec.thisHop)) paid.set(rec.thisHop, new Set());
      paid.get(rec.thisHop).add(c.bundle.bundleId);
    }
  }

  function finalize(id) {
    const p = payloads.get(id);
    if (!p.manifest || p.report) return;
    const m = p.manifest;
    if (!p.dest) {
      // A manifest that does not verify under the named clinic's pinned key is refused and
      // discarded, so a forged one sent first cannot block the genuine report.
      const clinic = m.meta?.clinic;
      const sourcePub = directory.clinics[clinic];
      let dest = null, reason = sourcePub ? null : "unknown_clinic";
      if (sourcePub) { try { dest = makeDest(kp, m, [], { sourcePub }); } catch (e) { reason = e.reason || e.message; } }
      if (!dest) { p.manifest = null; refuse({ payloadId: id, reason, clinic }); return; }
      p.clinic = clinic;
      p.dest = dest;
    }
    for (const index of [...p.chunks.keys()]) if (!p.chunks.get(index).ok) check(id, p, index);
    if (p.chunks.size < m.chunkCount) return;

    let file, bytes;
    try { ({ header: file, bytes } = unpackFile(openAt(encPriv, p.dest.reassemble(), id))); }
    catch { p.report = { status: "refused", reason: "decrypt_failed" }; refuse({ payloadId: id, reason: "decrypt_failed" }); return; }
    let summary = null;
    if (/\.json$/i.test(file.name)) { try { summary = JSON.parse(bytes.toString("utf8")); } catch {} }
    // Per-link transit for the first chunk, from the signed timestamps: leaving one custodian
    // to reaching the next. A long one is a hold (an outage the bundle waited through).
    const first = p.chunks.get(0);
    const hops = [];
    let prev = { node: p.clinic, at: m.meta.createdAt };
    for (const rec of first.custody) { hops.push({ from: prev.node, to: rec.thisHop, transitMs: rec.receivedAt - prev.at }); prev = { node: rec.thisHop, at: rec.forwardedAt }; }
    hops.push({ from: prev.node, to: eid, transitMs: first.arrivedAt - prev.at });
    p.report = {
      status: "verified", clinic: p.clinic, root: m.root, chunkCount: m.chunkCount, createdAt: m.meta.createdAt,
      verifiedAt: now(), file: { name: file.name, type: file.type, size: bytes.length }, bytes, summary,
      route: [p.clinic, ...first.custody.map((r) => r.thisHop), eid], hops,
      holds: hops.filter((h) => h.transitMs >= holdThresholdMs),
    };
  }

  return {
    // Accept one frame (Buffer). Returns the payloadId it touched, or null.
    ingest(buf, arrivedAt = now()) {
      const f = dec(buf);
      if (!f) { refuse({ reason: "unreadable_frame" }); return null; }
      if (f.kind === "manifest" && f.manifest?.payloadId) {
        const p = entry(f.manifest.payloadId);
        if (!p.manifest) p.manifest = f.manifest; else duplicates++;
        finalize(f.manifest.payloadId);
        return f.manifest.payloadId;
      }
      if (f.kind === "chunk" && f.bundle?.payloadId) {
        const p = entry(f.bundle.payloadId);
        if (p.chunks.has(f.bundle.index) || p.report?.status === "verified") { duplicates++; return f.bundle.payloadId; }
        p.chunks.set(f.bundle.index, { bundle: f.bundle, custody: f.custody || [], arrivedAt });
        finalize(f.bundle.payloadId);
        return f.bundle.payloadId;
      }
      refuse({ reason: "unknown_frame_kind" });
      return null;
    },
    report: (id) => payloads.get(id)?.report || null,
    // relayEid -> sorted bundle ids whose custody verified: what each relay is owed for.
    paidIds: () => Object.fromEntries([...paid].map(([relay, ids]) => [relay, [...ids].sort()])),
    state() {
      const reports = [...payloads].map(([payloadId, p]) => {
        const r = p.report;
        const base = { payloadId, clinic: p.manifest?.meta?.clinic ?? null, received: p.chunks.size, chunkCount: p.manifest?.chunkCount ?? null };
        if (!r) return { ...base, status: "in_transit" };
        const { bytes, ...rest } = r;
        return { ...base, ...rest };
      });
      const payouts = Object.fromEntries([...paid].map(([relay, ids]) => [relay, { bundles: ids.size, sats: ids.size * ratePerBundleSats }]));
      return { hub: eid, generatedAt: now(), ratePerBundleSats, reports, payouts, refusals: [...refusals], duplicates };
    },
  };
}
