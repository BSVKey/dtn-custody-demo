// Relay (orbiter / ground-relay) role: as a bundle passes through, stamp a signed
// custody receipt binding {prevHop, thisHop, bundleId, receivedAt, forwardedAt}. The
// chain of these across hops is the verifiable custody record. Optional per-hop
// micropayment is a dev-mode seam (see docs/BUILD-PLAN.md section 4), omitted here.
import { custodyReceipt } from "./lib/receipt.mjs";

export function makeRelay(kp, eid) {
  return {
    eid,
    pub: kp.pub,
    // Stamp custody for a bundle in transit. Returns the signed receipt.
    stamp(bundle, prevHop, receivedAt, forwardedAt) {
      return custodyReceipt(kp, {
        payloadId: bundle.payloadId,
        bundleId: bundle.bundleId,
        prevHop,
        thisHop: eid,
        receivedAt,
        forwardedAt,
      });
    },
  };
}
