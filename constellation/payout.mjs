// Payout keys for the constellation payment runs, shared by ttn-run.mjs (which pays them) and
// sweep.mjs (which collects them back).
//
// Keys are derived with HMAC-SHA256 under a secret taken from the funding key, so only whoever
// holds the funding key can spend what the satellites were paid: the code is public, and a public
// derivation would let anyone take the payments.
//   per-node     one key per relaying node:   HMAC(secret, "payout:<eid>")
//   per-payment  a fresh key per payment:     HMAC(secret, "payout:<eid>:<claimId>")
import { createHash, createHmac } from "node:crypto";
import { PrivateKey } from "@bsv/sdk";

export const PAYOUT_SCHEMES = ["per-payment", "per-node"];

export function payoutDeriver(funder, scheme) {
  if (!PAYOUT_SCHEMES.includes(scheme)) throw new Error(`unknown payout scheme ${scheme}`);
  const secret = createHash("sha256").update(`payout-seed:${funder.toWif()}`).digest();
  const cache = new Map();
  return (eid, claimId) => {
    const label = scheme === "per-node" ? `payout:${eid}` : `payout:${eid}:${claimId}`;
    if (!cache.has(label)) cache.set(label, PrivateKey.fromHex(createHmac("sha256", secret).update(label).digest("hex")));
    return cache.get(label);
  };
}
