// Contact-window link model for one store-and-forward path, in virtual time. Unlike
// transport/sim.mjs (one fixed blackout, no data rate), each link here has its own
// one-way light time, bit rate and transmit windows, and bundles serialize FIFO at the
// link rate. A bundle starts only if it fits before its window closes (no fragmenting
// across windows); otherwise it is held by the sending node until the next window.
//
// Windows are in SENDER time. For a downlink, the sender is the spacecraft, so its
// windows are the Earth tracks shifted earlier by the light time: it has to transmit a
// light time before the dish turns toward it.

export function shiftWindows(windows, byMs) {
  return windows.map(([s, e]) => [s + byMs, e + byMs]);
}

// Earliest start >= t at which a transmission of txMs fits inside a window.
function nextStart(windows, t, txMs) {
  if (!windows) return t;
  for (const [s, e] of windows) {
    const start = Math.max(t, s);
    if (start + txMs <= e) return start;
  }
  return null; // never fits in the plan
}

// hops: [eid, ...] (n nodes); links: n-1 of { id, owltMs, bps, windows|null }.
// items: [{ bundle, bytes, readyAt }] in source order. relays: { eid: relay agent }.
// Returns per-item timelines, custody receipts per bundle, gap records per link.
export function runPath({ hops, links, items, relays }) {
  const legs = items.map(() => []);
  let ready = items.map((it) => it.readyAt);
  const gaps = [];

  links.forEach((link, k) => {
    let free = -Infinity;
    const order = items.map((_, i) => i).sort((a, b) => ready[a] - ready[b] || a - b);
    const delayedBy = new Map(); // outage index -> bundleIds
    for (const i of order) {
      const txMs = Math.ceil((items[i].bytes * 8 * 1000) / link.bps);
      const t = Math.max(ready[i], free);
      const start = nextStart(link.windows, t, txMs);
      if (start === null) throw new Error(`bundle ${i} never fits on ${link.id}`);
      if (link.windows && start > ready[i]) {
        // Held across an outage if the window it went out in opened after it was ready.
        const w = link.windows.findIndex(([s, e]) => start >= s && start < e);
        if (link.windows[w][0] > ready[i]) {
          if (!delayedBy.has(w)) delayedBy.set(w, []);
          delayedBy.get(w).push(items[i].bundle.bundleId);
        }
      }
      free = start + txMs;
      legs[i].push({ link: link.id, readyAt: ready[i], txStart: start, txEnd: free, arriveAt: free + link.owltMs });
    }
    for (const [w, ids] of delayedBy) {
      gaps.push({
        kind: "gap/1", link: link.id,
        downAt: w > 0 ? link.windows[w - 1][1] : null, upAt: link.windows[w][0],
        bundlesDelayed: ids.sort(),
        note: "no transmit window (track ended or missed); bundles held by the sender until the next one.",
      });
    }
    ready = legs.map((l) => l[k].arriveAt);
  });

  // Custody: each relay signs on arrival (leg k-1) and forward (leg k).
  const custodyByBundle = new Map();
  items.forEach((it, i) => {
    const recs = [];
    for (let k = 1; k < hops.length - 1; k++) {
      recs.push(relays[hops[k]].stamp(it.bundle, hops[k - 1], legs[i][k - 1].arriveAt, legs[i][k].txStart));
    }
    custodyByBundle.set(it.bundle.bundleId, recs);
  });

  const arrivals = items
    .map((it, i) => ({ bundle: it.bundle, at: legs[i][links.length - 1].arriveAt }))
    .sort((a, b) => a.at - b.at || a.bundle.index - b.bundle.index);
  return { legs, arrivals, custodyByBundle, gaps };
}

// Bytes on the wire for one custody bundle: chunk + Merkle leaf + branch + headers.
export function wireBytes(bundle, overheadBytes) {
  return Buffer.from(bundle.bytesB64, "base64").length + 32 * (bundle.branch.length + 1) + overheadBytes;
}
