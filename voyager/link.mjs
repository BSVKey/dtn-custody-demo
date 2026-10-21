// Contact-window link model for one store-and-forward path, in virtual time. Unlike
// transport/sim.mjs (one fixed blackout, no data rate), each link here has its own
// one-way light time, bit rate and transmit windows, and bundles serialize FIFO at the
// link rate. A bundle starts only if it fits before its window closes (no fragmenting
// across windows); otherwise it is held by the sending node until the next window.
//
// Windows are in SENDER time. For a downlink, the sender is the spacecraft, so its
// windows are the Earth tracks shifted earlier by the light time: it has to transmit a
// light time before the dish turns toward it.
//
// Bit errors (optional, link.ber): a bundle is lost with probability 1-(1-ber)^bits. When a
// round's last bundle has landed, the receiver sends one NACK listing what is missing over
// link.reverse (its own light time, rate and windows); the sender resends those bundles
// once the NACK arrives, in its next window. Repeats until everything is through.

export function shiftWindows(windows, byMs) {
  return windows.map(([s, e]) => [s + byMs, e + byMs]);
}

// Earliest start >= t at which a transmission of txMs fits inside a window.
export function nextStart(windows, t, txMs) {
  if (!windows) return t;
  for (const [s, e] of windows) {
    const start = Math.max(t, s);
    if (start + txMs <= e) return start;
  }
  return null; // never fits in the plan
}

const txMsOf = (bytes, bps) => Math.ceil((bytes * 8 * 1000) / bps);
export const nackBytes = (n) => 48 + 4 * n;

function makePrng(seed) {
  let s = (seed >>> 0) || 1;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 2 ** 32; };
}

// hops: [eid, ...] (n nodes); links: n-1 of { id, owltMs, bps, windows|null, ber?, reverse? }.
// items: [{ bundle, bytes, readyAt }] in source order. relays: { eid: relay agent }.
// Returns per-item timelines, custody receipts per bundle, gap records and resends per link.
export function runPath({ hops, links, items, relays, seed = 7 }) {
  const prng = makePrng(seed);
  const legs = items.map(() => []);
  let ready = items.map((it) => it.readyAt);
  const gaps = [];
  const resends = [];

  links.forEach((link, k) => {
    let free = -Infinity;
    const delayedBy = new Map(); // window index -> bundleIds
    const attempts = items.map(() => 0);
    let pending = items.map((_, i) => i);
    const readyNow = [...ready];
    for (let round = 0; pending.length; round++) {
      if (round > 50) throw new Error(`${link.id}: still losing bundles after 50 rounds`);
      const lost = [];
      let roundEnd = -Infinity;
      for (const i of [...pending].sort((a, b) => readyNow[a] - readyNow[b] || a - b)) {
        const txMs = txMsOf(items[i].bytes, link.bps);
        const start = nextStart(link.windows, Math.max(readyNow[i], free), txMs);
        if (start === null) throw new Error(`bundle ${i} never fits on ${link.id}`);
        if (link.windows && start > readyNow[i]) {
          // Held across an outage if the window it went out in opened after it was ready.
          const w = link.windows.findIndex(([s, e]) => start >= s && start < e);
          if (link.windows[w][0] > readyNow[i]) {
            if (!delayedBy.has(w)) delayedBy.set(w, new Set());
            delayedBy.get(w).add(items[i].bundle.bundleId);
          }
        }
        free = start + txMs;
        attempts[i]++;
        const leg = { link: link.id, readyAt: ready[i], txStart: start, txEnd: free, arriveAt: free + link.owltMs, attempts: attempts[i] };
        roundEnd = Math.max(roundEnd, leg.arriveAt);
        const pLoss = link.ber ? 1 - (1 - link.ber) ** (items[i].bytes * 8) : 0;
        if (pLoss && prng() < pLoss) lost.push(i);
        else legs[i][k] = leg;
      }
      if (!lost.length) break;
      if (!link.reverse) throw new Error(`${link.id}: bundles lost and no reverse link for a NACK`);
      const rv = link.reverse, nTx = txMsOf(nackBytes(lost.length), rv.bps);
      const nackStart = nextStart(rv.windows, roundEnd, nTx);
      if (nackStart === null) throw new Error(`${link.id}: no reverse window for the NACK`);
      const nackArrive = nackStart + nTx + rv.owltMs;
      resends.push({ link: link.id, round: round + 1, bundleIds: lost.map((i) => items[i].bundle.bundleId), lastLandedAt: roundEnd, nackSentAt: nackStart, nackArriveAt: nackArrive });
      for (const i of lost) readyNow[i] = nackArrive;
      pending = lost;
    }
    for (const [w, ids] of delayedBy) {
      gaps.push({
        kind: "gap/1", link: link.id,
        downAt: w > 0 ? link.windows[w - 1][1] : null, upAt: link.windows[w][0],
        bundlesDelayed: [...ids].sort(),
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
  return { legs, arrivals, custodyByBundle, gaps, resends };
}

// Bytes on the wire for one custody bundle: chunk + Merkle leaf + branch + headers.
export function wireBytes(bundle, overheadBytes) {
  return Buffer.from(bundle.bytesB64, "base64").length + 32 * (bundle.branch.length + 1) + overheadBytes;
}
