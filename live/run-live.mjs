// Live delivery check: bind a delivery receipt to a REAL BSV settlement and verify it
// on chain. Uses a real pinned mainnet settlement (the same one the BSVKey fixtures
// use). In production the settlementRef comes from readSettlement(res).txid of the
// payment made for this delivery; here it is pinned so the check is reproducible.
//
// Optionally pass an anchor txid (ANCHOR_TXID env) to also verify the provenance anchor
// for the manifest root.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { genKeypair } from "../agent/lib/keys.mjs";
import { deliveryReceipt } from "../agent/lib/receipt.mjs";
import { leafHash, buildTree } from "../agent/lib/merkle.mjs";
import { chunk } from "../agent/source.mjs";
import { verifyDeliveryLive } from "./verify-delivery-live.mjs";

// A real BSV mainnet settlement: 5942 sats to the seller, from the BSVKey fixtures.
const REAL = {
  settlementRef: "77030c6192c6e86b808f1d7afa210b874bad86ed6a6b4ef69a8ccebc51ec83c6",
  payTo: "1LdqUbdZ6GY71KxThU6aKfuKXxgmTn82cv",
  amountAtomic: 5942,
};
// The pinned provenance anchor: the Merkle root of live/anchored-payload.txt, committed
// on-chain in an OP_RETURN. Overridable via env for a different run's root/anchor.
const here = dirname(fileURLToPath(import.meta.url));
const payloadRoot = "0x" + buildTree(chunk(readFileSync(join(here, "anchored-payload.txt")), 64).map((c) => leafHash(c))).root;
const PINNED_ANCHOR = "d49777e46abe6dfa02586d3ab81f91c52fb9026dd667d6adafd848fa8889e8ca";
const root = process.env.MANIFEST_ROOT || payloadRoot;
const anchorTxid = process.env.ANCHOR_TXID || PINNED_ANCHOR;

const kp = genKeypair();
const receipt = deliveryReceipt(kp, {
  payloadId: "0xrover-frame-001", root, rail: "bsv", network: "bsv", ...REAL,
});

// The settlement the verifier itself paid (production: readSettlement(res).txid).
const paid = { settlementRef: REAL.settlementRef };

console.log("== Live delivery check ==");
const res = await verifyDeliveryLive(receipt, paid, {
  minSats: REAL.amountAtomic, minConf: 1, anchorTxid,
});
if (res.ok) {
  console.log("  bind (verifier's own txid)   : PASS");
  console.log(`  settlement on chain           : PASS (${res.settlement.paidSats} sats to ${res.settlement.payTo}, ${res.settlement.confirmations} conf)`);
  console.log(`  provenance anchor             : ${res.anchor ? "PASS (" + res.anchor.confirmations + " conf)" : "not provided (set ANCHOR_TXID to verify)"}`);
  console.log("  OVERALL                       : PASS  (delivery bound to a REAL, on-chain-verified BSV settlement)");
} else {
  console.log(`  FAILED at stage=${res.stage}: ${res.reason || JSON.stringify(res)}`);
  process.exit(1);
}

// Refusal controls, live: a different txid and an unbound check must both fail.
const wrong = await verifyDeliveryLive(receipt, { settlementRef: "0".repeat(64) }, { minSats: REAL.amountAtomic });
const unbound = await verifyDeliveryLive(receipt, {}, { minSats: REAL.amountAtomic });
console.log("  refuses a different txid      :", wrong.reason === "settlementRef_not_mine" ? "PASS" : "FAIL");
console.log("  refuses unbound               :", String(unbound.reason).startsWith("unbound") ? "PASS" : "FAIL");
