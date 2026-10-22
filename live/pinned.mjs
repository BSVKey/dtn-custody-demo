// Real Bitcoin BSV mainnet transactions the live checks verify, read-only.
//
// SETTLEMENT: a 5942-sat payment to the seller (from the BSVKey fixtures). In production the
// settlementRef is readSettlement(res).txid of the payment made for this delivery.
// ANCHOR: an OP_RETURN carrying the Merkle root (64-byte chunks) of ANCHORED_PAYLOAD.
import { fileURLToPath } from "node:url";

export const SETTLEMENT = {
  settlementRef: "77030c6192c6e86b808f1d7afa210b874bad86ed6a6b4ef69a8ccebc51ec83c6",
  payTo: "1LdqUbdZ6GY71KxThU6aKfuKXxgmTn82cv",
  amountAtomic: 5942,
};
export const ANCHOR_TXID = "733dcc21bb592ab70118fcd68f9e398dd0a51e135e0fe3570ab3ea3724b51207";
export const ANCHORED_PAYLOAD = fileURLToPath(new URL("./anchored-payload.txt", import.meta.url));
