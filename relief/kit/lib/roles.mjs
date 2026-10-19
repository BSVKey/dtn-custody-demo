// The three roles of a relief network, independent of transport and storage.
//
//   clinic: seals a file to the hub, chunks it, signs the manifest, sends it to its next hop.
//           Keeps what it sent, and resends chunks when the hub asks (a request signed by the hub).
//   relay:  courier phones and satellite relays. Signs a custody receipt for every chunk it
//           takes, appends it to the frame and forwards to its next hop. Remembers which node
//           each report came from, so the hub's resend requests can travel back the same way.
//   hub:    collects manifests and chunks, and once a report is complete checks the clinic's
//           signature, every chunk against the root, and every custody receipt against the
//           pinned keys; then decrypts it. When a report stays incomplete, it asks the clinic to
//           resend what is missing. Holds and transit times come from the signed receipt
//           timestamps. Pays only for receipts that verified.
//
// Revoked keys (a lost or stolen device): the directory lists { eid, pub, revokedAt }. A key is
// accepted only for frames that reached the hub before revokedAt, by the hub's own clock, so
// work done before the loss still counts and nothing signed with the key afterwards does.
//
// Frames are JSON, version 1:
//   { v, kind: "manifest", manifest, lastHop }
//   { v, kind: "chunk", bundle, custody: [receipts], lastHop }
//   { v, kind: "resend", request }   request: signed by the hub { kind: "resend/1", payloadId,
//                                    clinic, manifest: bool, indexes: [..], route, seq, at }
//                                    route: the custodians from the clinic to the hub, from the
//                                    receipts, for relays that do not remember the report.
import { prepare } from "../../../agent/source.mjs";
import { makeRelay } from "../../../agent/relay.mjs";
import { makeDest } from "../../../agent/dest.mjs";
import { auditCustodyChain, signRecord, verifyRecord } from "../../../agent/lib/receipt.mjs";
import { sealTo, openAt } from "./seal.mjs";

export const FRAME_V = 1;
const enc = (o) => Buffer.from(JSON.stringify(o), "utf8");
const dec = (b) => { try { const f = JSON.parse(Buffer.from(b).toString("utf8")); return f && f.v === FRAME_V ? f : null; } catch { return null; } };
const payloadOf = (f) => f.manifest?.payloadId ?? f.bundle?.payloadId ?? f.request?.payloadId ?? null;

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

// The key valid for `eid` at hub time `at`: the current key, unless it was revoked later than
// `at` from an older key (then that older key). `current` is { eid: pub }.
export function keyAt(current, revoked = [], eid, at) {
  const later = revoked.filter((r) => r.eid === eid && at < r.revokedAt).sort((a, b) => a.revokedAt - b.revokedAt);
  return later.length ? later[0].pub : current[eid];
}
const keysAt = (current, revoked, at) => {
  if (!revoked?.length) return current;
  const out = { ...current };
  for (const eid of new Set(revoked.map((r) => r.eid))) out[eid] = keyAt(current, revoked, eid, at);
  return out;
};
const isRevoked = (revoked = [], pub, at) => revoked.some((r) => r.pub === pub && at >= r.revokedAt);

// ---- clinic ------------------------------------------------------------------------------
// store: { save(payloadId, { manifest, bundles }), load(payloadId) } so resends survive a restart.
export function makeClinic({ kp, eid, next, hubEncPub, hubSignPub = null, chunkSize = 1024, maxResendsPerChunk = 5, store = null, now = Date.now }) {
  let seq = 0;
  const sent = new Map();          // payloadId -> { manifest, bundles }
  const resent = new Map();        // `${payloadId} ${index}` -> times resent
  const seenRequests = new Set();  // request claimIds already handled
  const load = (id) => sent.get(id) ?? (store ? store.load(id) : null);
  return {
    // file: { name, type?, bytes: Buffer }. Returns { payloadId, root, chunks }.
    async sendFile(transport, file) {
      const createdAt = now();
      const payloadId = `${eid.replace(/^dtn:\/\//, "").replace(/\/$/, "")}/${createdAt}-${seq++}`;
      const inner = packFile({ name: file.name, type: file.type || null, createdAt }, file.bytes);
      const sealed = sealTo(hubEncPub, inner, payloadId);
      const { manifest, bundles } = prepare(kp, sealed, { payloadId, chunkSize, meta: { clinic: eid, createdAt } });
      sent.set(payloadId, { manifest, bundles });
      store?.save(payloadId, { manifest, bundles });
      await transport.send(next, enc({ v: FRAME_V, kind: "manifest", manifest, lastHop: eid }));
      for (const bundle of bundles) await transport.send(next, enc({ v: FRAME_V, kind: "chunk", bundle, custody: [], lastHop: eid }));
      return { payloadId, root: manifest.root, chunks: bundles.length };
    },
    // A resend request from the hub. Returns { ok, resent } or { ok: false, reason }.
    async onFrame(transport, buf) {
      const f = dec(buf);
      if (!f || f.kind !== "resend") return { ok: false, reason: "not_a_resend_request" };
      const q = f.request;
      const v = verifyRecord(q || {});
      if (!v.ok) return { ok: false, reason: v.reason };
      if (!hubSignPub || v.signer !== hubSignPub) return { ok: false, reason: "not_signed_by_hub" };
      if (q.kind !== "resend/1" || q.clinic !== eid) return { ok: false, reason: "not_for_this_clinic" };
      if (seenRequests.has(q.claimId)) return { ok: true, resent: 0, duplicate: true };
      seenRequests.add(q.claimId);
      const p = load(q.payloadId);
      if (!p) return { ok: false, reason: "unknown_payload" };
      let n = 0;
      if (q.manifest) { await transport.send(next, enc({ v: FRAME_V, kind: "manifest", manifest: p.manifest, lastHop: eid })); n++; }
      for (const index of q.indexes || []) {
        const b = p.bundles[index];
        const k = `${q.payloadId} ${index}`;
        if (!b || (resent.get(k) ?? 0) >= maxResendsPerChunk) continue;
        resent.set(k, (resent.get(k) ?? 0) + 1);
        await transport.send(next, enc({ v: FRAME_V, kind: "chunk", bundle: b, custody: [], lastHop: eid }));
        n++;
      }
      return { ok: true, resent: n };
    },
  };
}

// ---- relay (courier or satellite relay) ----------------------------------------------------
// back: optional initial Map(payloadId -> node it came from), e.g. rebuilt from the claims log.
export function makeRelayNode({ kp, eid, next, now = Date.now, onClaim = () => {}, back = new Map() }) {
  const relay = makeRelay(kp, eid);
  let forwarded = 0, returned = 0;
  return {
    get forwarded() { return forwarded; },
    get returned() { return returned; },
    back,
    async onFrame(transport, buf) {
      const f = dec(buf);
      if (!f) return;
      if (f.kind === "resend") {
        // Back toward the clinic, the way the report came; a relay that does not remember the
        // report (a replacement device) follows the route in the signed request.
        const route = f.request?.route || [];
        const at = route.indexOf(eid);
        const to = back.get(f.request?.payloadId) ?? (at > 0 ? route[at - 1] : null);
        if (!to) return;
        await transport.send(to, buf);
        returned++;
        return;
      }
      const id = payloadOf(f);
      if (id && f.lastHop) back.set(id, f.lastHop);
      if (f.kind === "chunk" && f.bundle && Array.isArray(f.custody)) {
        const t = now();
        const receipt = relay.stamp(f.bundle, f.lastHop, t, t);
        f.custody.push(receipt);
        onClaim({ payloadId: f.bundle.payloadId, bundleId: f.bundle.bundleId, claimId: receipt.claimId, at: t, from: f.lastHop });
      }
      f.lastHop = eid;
      await transport.send(next, enc(f));
      forwarded++;
    },
  };
}

// ---- hub -------------------------------------------------------------------------------------
// directory: { clinics: { eid: signPub }, relays: { eid: signPub }, revoked: [{ eid, pub, revokedAt, reason }] }
export function makeHub({ kp, eid, encPriv, directory, ratePerBundleSats = 50, holdThresholdMs = 10 * 60_000, resendAfterMs = 10 * 60_000, maxResends = 6, now = Date.now }) {
  let dir = directory;
  const payloads = new Map(); // payloadId -> { manifest, manifestAt, dest, clinic, chunks: Map(index -> { bundle, custody, arrivedAt, ok }), report, lastAt, via, resends, nextResendAt }
  const refusals = [];
  const paid = new Map();     // relayEid -> Set(bundleId) with verified custody
  let duplicates = 0, resendSeq = 0, requests = 0;

  const refuse = (r) => { refusals.push({ at: now(), ...r }); };
  const entry = (id) => { if (!payloads.has(id)) payloads.set(id, { manifest: null, chunks: new Map(), report: null, resends: 0 }); return payloads.get(id); };

  // Check a stored chunk; a bad one is dropped (and refused) so a good copy can still arrive.
  function check(id, p, index) {
    const c = p.chunks.get(index);
    const r = p.dest.receiveBundle(c.bundle);
    if (!r.ok) { p.chunks.delete(index); refuse({ payloadId: id, index, reason: r.reason }); return; }
    const revokedHop = c.custody.findIndex((rec) => isRevoked(dir.revoked, rec.signerPub, c.arrivedAt));
    if (revokedHop >= 0) { p.chunks.delete(index); refuse({ payloadId: id, index, reason: "key_revoked", hop: revokedHop, claimedBy: c.custody[revokedHop].thisHop }); return; }
    const a = auditCustodyChain(c.custody, { bundleId: c.bundle.bundleId, keys: keysAt(dir.relays, dir.revoked, c.arrivedAt), origin: p.clinic });
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
      const revoked = isRevoked(dir.revoked, m.signerPub, p.manifestAt);
      const sourcePub = keyAt(dir.clinics, dir.revoked, clinic, p.manifestAt);
      let dest = null, reason = revoked ? "key_revoked" : sourcePub ? null : "unknown_clinic";
      if (!reason) { try { dest = makeDest(kp, m, [], { sourcePub }); } catch (e) { reason = e.reason || e.message; } }
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
      route: [p.clinic, ...first.custody.map((r) => r.thisHop), eid], hops, resends: p.resends,
      holds: hops.filter((h) => h.transitMs >= holdThresholdMs),
    };
  }

  return {
    // Accept one frame (Buffer). Returns the payloadId it touched, or null.
    ingest(buf, arrivedAt = now()) {
      const f = dec(buf);
      if (!f) { refuse({ reason: "unreadable_frame" }); return null; }
      const id = payloadOf(f);
      if (f.kind === "manifest" && id) {
        const p = entry(id);
        p.lastAt = arrivedAt; if (f.lastHop) p.via = f.lastHop;
        if (!p.manifest) { p.manifest = f.manifest; p.manifestAt = arrivedAt; } else duplicates++;
        finalize(id);
        return id;
      }
      if (f.kind === "chunk" && id) {
        const p = entry(id);
        p.lastAt = arrivedAt; if (f.lastHop) p.via = f.lastHop;
        if (!p.clinic && f.custody?.[0]?.prevHop) p.origin = f.custody[0].prevHop;
        if (f.custody?.length) p.route = [f.custody[0].prevHop, ...f.custody.map((r) => r.thisHop)];
        if (p.chunks.has(f.bundle.index) || p.report?.status === "verified") { duplicates++; return id; }
        p.chunks.set(f.bundle.index, { bundle: f.bundle, custody: f.custody || [], arrivedAt });
        finalize(id);
        return id;
      }
      refuse({ reason: "unknown_frame_kind" });
      return null;
    },
    // Resend requests that are due. Returns [{ to, frame }]: send each frame to `to`, the relay
    // the report last came through. Waits resendAfterMs after the last frame for that report,
    // then backs off (doubling) up to maxResends requests.
    tick(t = now()) {
      const out = [];
      for (const [id, p] of payloads) {
        if (p.report || !p.via || p.resends >= maxResends) continue;
        const clinic = p.clinic ?? p.manifest?.meta?.clinic ?? p.origin;
        if (!clinic || !dir.clinics[clinic]) continue;
        const due = Math.max(p.lastAt + resendAfterMs, p.nextResendAt ?? 0);
        if (t < due) continue;
        const indexes = p.manifest ? [...Array(p.manifest.chunkCount).keys()].filter((i) => !p.chunks.has(i)) : [];
        const request = signRecord(kp, { kind: "resend/1", payloadId: id, clinic, manifest: !p.manifest, indexes, route: p.route ?? [clinic, p.via], seq: resendSeq++, at: t });
        p.resends++;
        p.nextResendAt = t + resendAfterMs * 2 ** p.resends;
        requests++;
        out.push({ to: p.via, frame: enc({ v: FRAME_V, kind: "resend", request }) });
      }
      return out;
    },
    // Swap in an updated directory (for example after a device was revoked and re-keyed).
    setDirectory(d) { dir = d; },
    report: (id) => payloads.get(id)?.report || null,
    // relayEid -> sorted bundle ids whose custody verified: what each relay is owed for.
    paidIds: () => Object.fromEntries([...paid].map(([relay, ids]) => [relay, [...ids].sort()])),
    state() {
      const reports = [...payloads].map(([payloadId, p]) => {
        const r = p.report;
        const base = { payloadId, clinic: p.manifest?.meta?.clinic ?? p.origin ?? null, received: p.chunks.size, chunkCount: p.manifest?.chunkCount ?? null, resends: p.resends };
        if (!r) return { ...base, status: "in_transit" };
        const { bytes, ...rest } = r;
        return { ...base, ...rest };
      });
      const payouts = Object.fromEntries([...paid].map(([relay, ids]) => [relay, { bundles: ids.size, sats: ids.size * ratePerBundleSats }]));
      return { hub: eid, generatedAt: now(), ratePerBundleSats, reports, payouts, refusals: [...refusals], duplicates, resendRequests: requests, revoked: (dir.revoked || []).map(({ eid: e, revokedAt, reason }) => ({ eid: e, revokedAt, reason })) };
    },
  };
}
