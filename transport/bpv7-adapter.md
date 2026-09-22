# BPv7 transport adapter (the real-transport seam)

`sim.mjs` is the in-process transport used for tests and the offline demo. The real
deployment swaps it for **BPv7 (RFC 9171)** bundles carried by a bundle agent, with no
change to the application layer (`agent/`), which only ever sees: emit a bundle, be
handed a bundle, know the previous hop.

## Primary: µD3TN (BPv7, flight heritage on ESA OPS-SAT)
- Run one µD3TN instance per node (source, relaya, relayb, dest) in the containers
  from `../docker-compose.yml`.
- Attach our agent over µD3TN's **Application Agent Protocol (AAP/AAP2)**: register an
  endpoint, `SEND` a bundle payload, receive with `RECV`. Our bundle body is the JSON
  `{payloadId,index,leafHex,bytesB64,branch}`; the manifest and custody receipts are
  their own bundles to well-known endpoints (`dtn://<node>/manifest`, `/custody`).
- Routing: a static route / contact plan matching `../contact-plans/*.json`.

## Fallback: dtn7-rs (BPv7, Rust)
- One `dtnd` per node; our agent speaks the REST/WebSocket application interface.
- Same bundle bodies; same endpoints.

## Link shaping and occultation (netem)
- Between containers, shape each veth with `tc qdisc ... netem delay <one_way> loss
  <pct> reorder <pct>`.
- Drive occultation from the contact plan: bring the link `down`/`up` on schedule
  (drop the veth or a `netem loss 100%` window). µD3TN/dtn7 hold bundles across the
  outage (store-and-forward); the agent emits the gap object exactly as in the sim.

## Contract the adapter must satisfy (so the app layer is unchanged)
1. Reliable, possibly-reordered, possibly-delayed delivery of each bundle (custody).
2. At each relay, invoke `relay.stamp(bundle, prevHop, receivedAt, forwardedAt)` before
   forwarding, and carry the returned custody receipt onward.
3. Deliver bundles and custody receipts to the destination agent.
4. Surface link down/up events so `gapObject(...)` can be built.

Meeting that contract is milestone **M0 + the transport half of M2/M3** in the build
plan. Everything in `agent/` already runs against it today via `sim.mjs`.
