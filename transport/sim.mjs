// In-process DTN transport SIMULATOR. It models the store-and-forward behaviour of a
// multi-hop delay/disruption-tolerant link deterministically, so the whole
// application layer runs and is testable offline with no BPv7 daemon, no docker, and
// no netem. The REAL transport (BPv7 over uD3TN/dtn7-rs + netem) is a drop-in behind
// the same shape; see transport/bpv7-adapter.md. This is where the "compressed time"
// and the occultation window live.
//
// Path: source -> relaya -(L2)- relayb -> dest. Links carry a one-way delay; the
// occulted link (default L2) is DOWN during [downMs, upMs): a bundle that would cross
// during the outage is HELD and departs at upMs (store-and-forward), which both delays
// it and reorders it relative to its neighbours. Reorder jitter is added on every
// link so arrival order != send order even without an outage. Loss defaults to 0
// because custody guarantees delivery; a nonzero loss is supported for stress runs.

function makePrng(seed) {
  let s = (seed >>> 0) || 1;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 2 ** 32; };
}

export const defaultSimPlan = {
  name: "sim-moon-occultation",
  seed: 42,
  hops: ["dtn://source/", "dtn://relaya/", "dtn://relayb/", "dtn://dest/"],
  oneWayMs: 300,        // per link, compressed
  staggerMs: 50,        // gap between successive bundle departures at the source
  processMs: 50,        // relay receive->forward processing
  jitterMs: 700,        // max reorder jitter added per link
  lossPct: 0,           // custody => reliable; raise for stress runs
  occultation: { link: "L2", downMs: 500, upMs: 2200 }, // the blackout on relaya->relayb
};

// Run all bundles through the simulated path. `relays` maps an eid to a relay agent
// (with .stamp). Returns the arrival-ordered bundles, the custody receipts per bundle,
// the link events for the occulted link, and the delayed/lost sets.
export function simulate({ plan = defaultSimPlan, bundles, relays }) {
  const prng = makePrng(plan.seed);
  const [srcEid, aEid, bEid, dstEid] = plan.hops;
  const occ = plan.occultation;

  // Occultation only affects the L2 hop (relaya -> relayb, hop index 1).
  const held = (link, departMs) =>
    link === occ.link && departMs >= occ.downMs && departMs < occ.upMs ? occ.upMs : departMs;

  const linkOfHop = ["L1", "L2", "L3"]; // hop k crosses linkOfHop[k]
  const arrivals = [];       // { bundle, destArrival }
  const custodyByBundle = new Map();
  const delayed = new Set();
  const lost = [];

  bundles.forEach((bundle, i) => {
    let t = i * plan.staggerMs;   // departs source
    let prevHop = srcEid;
    let dropped = false;

    for (let hop = 0; hop < 3; hop++) {
      const link = linkOfHop[hop];
      const departFromNode = t;
      const crossAt = held(link, departFromNode);
      if (crossAt !== departFromNode) delayed.add(bundle.bundleId);
      if (plan.lossPct > 0 && prng() * 100 < plan.lossPct) { dropped = true; break; }
      const jitter = Math.floor(prng() * plan.jitterMs);
      const arrival = crossAt + plan.oneWayMs + jitter;

      const thisEid = plan.hops[hop + 1];
      if (thisEid === aEid || thisEid === bEid) {
        // relay node: stamp custody (received on arrival, forwarded after processing)
        const relay = relays[thisEid];
        const receivedAt = arrival;
        const forwardedAt = arrival + plan.processMs;
        const receipt = relay.stamp(bundle, prevHop, receivedAt, forwardedAt);
        if (!custodyByBundle.has(bundle.bundleId)) custodyByBundle.set(bundle.bundleId, []);
        custodyByBundle.get(bundle.bundleId).push(receipt);
        t = forwardedAt;
        prevHop = thisEid;
      } else {
        // destination
        arrivals.push({ bundle, destArrival: arrival });
      }
    }
    if (dropped) lost.push(bundle.bundleId);
  });

  // Deliver to the destination in ARRIVAL order (out of order vs. index).
  arrivals.sort((x, y) => x.destArrival - y.destArrival || x.bundle.index - y.bundle.index);

  const linkEvents = [
    { link: occ.link, event: "down", t: occ.downMs },
    { link: occ.link, event: "up", t: occ.upMs },
  ];

  return {
    arrivalOrder: arrivals.map((a) => a.bundle),
    custodyByBundle,
    linkEvents,
    delayed: [...delayed],
    lost,
    occultedLink: occ.link,
  };
}
