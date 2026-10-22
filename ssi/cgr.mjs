// Contact graph routing: the earliest-arrival path for a bundle of `bytes` from `node` at
// time t to `dst`, over the contact list (each { from, to, start, end, rateBps, owltMs,
// nextFree }). Transmissions on a contact are serialized: the first hop starts no earlier
// than the contact's nextFree; later hops are planned from the contact's start (the bundle
// is re-routed at every node, as a BPA running CGR does). Returns { hops: [contact...],
// arrival } or null when nothing reaches dst within the plan.
export function route(contacts, node, dst, t, bytes, { exclude = new Set() } = {}) {
  const byFrom = new Map();
  for (const c of contacts) { if (!byFrom.has(c.from)) byFrom.set(c.from, []); byFrom.get(c.from).push(c); }
  const arr = new Map([[node, t]]), via = new Map(), done = new Set();
  const txMs = (c) => Math.ceil((bytes * 8 * 1000) / c.rateBps);
  for (;;) {
    let u = null, best = Infinity;
    for (const [n, a] of arr) if (!done.has(n) && a < best) { best = a; u = n; }
    if (u === null) return null;
    if (u === dst) break;
    done.add(u);
    for (const c of byFrom.get(u) || []) {
      if (c.end <= best || done.has(c.to) || exclude.has(c.to)) continue;
      const depart = Math.max(best, c.start, u === node ? c.nextFree ?? 0 : 0);
      const tx = txMs(c);
      if (depart + tx > c.end) continue;
      const a = depart + tx + c.owltMs;
      if (a < (arr.get(c.to) ?? Infinity)) { arr.set(c.to, a); via.set(c.to, c); }
    }
  }
  const hops = [];
  for (let n = dst; n !== node; n = via.get(n).from) hops.unshift(via.get(n));
  return { hops, arrival: arr.get(dst) };
}
