// Custody chains over routes nobody listed in advance.
//
// verifyCustodyChain (receipt.mjs) checks a bundle against a pinned, ordered hop list,
// which suits planned paths (lander, orbiter, ground). A constellation reroutes
// constantly, so here the verifier instead accepts ANY path that:
//   - starts at the expected source and ends at the expected destination,
//   - links hop to hop (each prevHop is the previous thisHop),
//   - has every hop signed by a key the verifier's authorizer accepts for that node at
//     that time (a pinned directory here; a rotating key registry in production),
//   - covers this bundle at every hop (a per-bundle receipt, or a batch receipt plus an
//     inclusion proof), and
//   - moves forward in time (allowing a configured clock skew).
// A node may appear more than once: after a reroute a bundle can legitimately pass back
// through a satellite it visited before. Revisits are counted, not refused; the chain
// and time checks are what stop a spliced or replayed segment.
// Signatures are checked once per record and cached, so a batch receipt shared by
// thousands of bundles costs one Ed25519 verification.
import { verifyRecord } from "./receipt.mjs";
import { BATCH_KIND, inBatch } from "./batch.mjs";

export function verifyPath(links, { bundleId, source, destination, authorize, maxHops = 64, skewMs = 0, cache = new Map() }) {
  const fail = (reason, hop) => ({ ok: false, reason, hop });
  if (!Array.isArray(links) || links.length === 0) return fail("empty_path", null);
  if (links.length > maxHops) return fail("too_many_hops", null);
  if (typeof authorize !== "function") return fail("no_authorizer", null);
  const seen = new Set();
  let prev = null, revisits = 0;
  for (let i = 0; i < links.length; i++) {
    const { receipt: r, proof } = links[i];
    let v = cache.get(r?.claimId);
    if (!v) { v = verifyRecord(r); if (r?.claimId) cache.set(r.claimId, v); }
    if (!v.ok) return fail(v.reason, i);
    let t0, t1;
    if (r.kind === BATCH_KIND) {
      if (!inBatch(r, bundleId, proof)) return fail("not_in_batch", i);
      t0 = r.from; t1 = r.to;
    } else if (r.kind === "custody/1") {
      if (r.bundleId !== bundleId) return fail("wrong_bundle", i);
      t0 = r.receivedAt; t1 = r.forwardedAt;
    } else return fail("unknown_record_kind", i);
    const a = authorize(v.signer, r.thisHop, t0);
    if (!a.ok) return fail(a.reason || "signer_not_authorized", i);
    if (i === 0 ? r.prevHop !== source : r.prevHop !== prev.thisHop) return fail(i === 0 ? "wrong_source" : "chain_break", i);
    if (seen.has(r.thisHop)) revisits++;
    seen.add(r.thisHop);
    if (prev && t1 + skewMs < prev.t0) return fail("time_regression", i);
    prev = { thisHop: r.thisHop, t0 };
  }
  if (prev.thisHop !== destination) return fail("wrong_destination", links.length - 1);
  return { ok: true, hops: links.length, revisits };
}

// A pinned key directory: node id -> public key (or list of keys). Suitable for tests and
// small networks; fleets use a signed, rotating registry with the same authorize shape.
export function pinnedDirectory(map) {
  return (pub, eid) => {
    const k = map instanceof Map ? map.get(eid) : map[eid];
    const ok = Array.isArray(k) ? k.includes(pub) : k === pub;
    return ok ? { ok: true } : { ok: false, reason: k === undefined ? "unknown_node" : "signer_not_authorized" };
  };
}

// Put one bundle's hop records in route order, starting from the source. `entries` are
// { receipt, proof } found for this bundle across the downlinked ledgers.
export function assemblePath(entries, source) {
  const byPrev = new Map();
  for (const e of entries) {
    const list = byPrev.get(e.receipt.prevHop) || [];
    list.push(e);
    byPrev.set(e.receipt.prevHop, list);
  }
  const out = [];
  const used = new Set();
  let at = source;
  for (;;) {
    const next = (byPrev.get(at) || []).filter((e) => !used.has(e)).sort((x, y) => (x.receipt.from ?? x.receipt.receivedAt) - (y.receipt.from ?? y.receipt.receivedAt))[0];
    if (!next) break;
    used.add(next);
    out.push(next);
    at = next.receipt.thisHop;
    if (out.length > entries.length) break;
  }
  return out;
}
