# Custody at constellation scale

Thousands of satellites, routes that change while bundles are in flight, and one signed
receipt per satellite per contact instead of one per bundle.

```
node constellation/run.mjs            # 4,032 satellites; 10k, 50k and 200k bundles; outages; attacks
node constellation/run.mjs --small    # the same in seconds, on 144 satellites
```

Results: [RESULTS.md](RESULTS.md).

## What is new here

- **Batch receipts** (`agent/lib/batch.mjs`, record kind `custody-batch/1`). At the end of
  a contact each node signs one record: previous hop, itself, the time window, how many
  bundles, and the Merkle root over their bundle ids. Any single bundle is proven with that
  record plus a short inclusion proof.
- **Routes nobody listed in advance** (`agent/lib/path.mjs`, `verifyPath`). The verifier
  accepts any path that starts at the source, ends at the destination, links hop to hop,
  moves forward in time, covers the bundle at every hop, and is signed at every hop by a key
  the authorizer accepts for that node at that time. A satellite visited twice after a
  reroute is accepted and counted. Each batch signature is checked once and cached.
- **Pluggable authorization.** A pinned key directory here; the Operator Edition supplies
  a signed fleet registry with rotation and compromise revocation through the same
  `authorize(pub, node, time)` call.

## Real orbits

`orbits.mjs` replaces the grid with real geometry: public Starlink two-line element sets
from CelesTrak, propagated with SGP4 (satellite.js) every minute; inter-satellite links
from range and line of sight, kept while geometry allows; ground stations at public city
locations with a 25-degree elevation mask. The laser-link layout is a geometric model,
since operators do not publish theirs. `node constellation/orbits-run.mjs` fetches the
current elements into `constellation/.tle-cache/` (not committed) and records the snapshot
it used. Results: [ORBITS-RESULTS.md](ORBITS-RESULTS.md).

## The model (grid)

A grid of orbital planes with in-plane and cross-plane links, a polar band where
cross-plane links drop, random link failures, ground stations whose access moves every
epoch (and, in the harsh case, go offline), and routing recomputed every epoch from where
each bundle is. It is an approximation for measuring custody records, routing churn and
verification cost, not an orbit propagator or a link simulator.
