// The full LIVE delivery check: the two halves together.
//   1. bindDelivery  - the receipt names the settlement the VERIFIER paid (its own txid)
//   2. verifySettlementOnChain - that txid actually paid payTo the amount, on chain
// Optionally also verifies a provenance anchor for the manifest root.
import { bindDelivery } from "../agent/lib/receipt.mjs";
import { verifySettlementOnChain } from "./settlement.mjs";
import { verifyAnchorOnChain } from "./anchor.mjs";

export async function verifyDeliveryLive(receipt, expected, { minSats = 1, minConf = 1, anchorTxid } = {}) {
  const bind = bindDelivery(receipt, expected);
  if (!bind.ok) return { ok: false, stage: "bind", ...bind };
  const chain = await verifySettlementOnChain(receipt.settlementRef, {
    payTo: receipt.payTo, minSats: minSats || Number(receipt.amountAtomic) || 1, minConf,
  });
  if (!chain.ok) return { ok: false, stage: "settlement", ...chain };
  let anchor = null;
  if (anchorTxid) {
    anchor = await verifyAnchorOnChain(anchorTxid, receipt.root);
    if (!anchor.ok) return { ok: false, stage: "anchor", ...anchor };
  }
  return { ok: true, settlement: chain, anchor };
}
