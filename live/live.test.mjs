// Offline tests for the live path (the OP_RETURN parser and the delivery composition),
// plus a network-gated check against the real settlement. The network test runs only
// with LIVE=1 so the default suite stays offline and deterministic.
import { test } from "node:test";
import assert from "node:assert/strict";
import { opReturnCarriesRoot } from "./anchor.mjs";
import { genKeypair } from "../agent/lib/keys.mjs";
import { deliveryReceipt } from "../agent/lib/receipt.mjs";
import { verifyDeliveryLive } from "./verify-delivery-live.mjs";

const root = "0x" + "ab".repeat(32);

test("opReturnCarriesRoot: finds the root in an OP_RETURN output", () => {
  const tx = { vout: [
    { scriptPubKey: { type: "pubkeyhash", hex: "76a914" + "00".repeat(20) + "88ac" } },
    { scriptPubKey: { type: "nulldata", asm: "OP_FALSE OP_RETURN " + "ab".repeat(32), hex: "006a20" + "ab".repeat(32) } },
  ] };
  assert.equal(opReturnCarriesRoot(tx, root), true);
});

test("opReturnCarriesRoot: false when the root is absent", () => {
  const tx = { vout: [{ scriptPubKey: { type: "nulldata", asm: "OP_FALSE OP_RETURN " + "cd".repeat(32), hex: "006a20" + "cd".repeat(32) } }] };
  assert.equal(opReturnCarriesRoot(tx, root), false);
});

test("live delivery composition: unbound is refused before any chain read", async () => {
  const receipt = deliveryReceipt(genKeypair(), {
    payloadId: "0xp", root, rail: "bsv", network: "bsv",
    settlementRef: "0".repeat(64), payTo: "1LdqUbdZ6GY71KxThU6aKfuKXxgmTn82cv", amountAtomic: 5942,
  });
  const res = await verifyDeliveryLive(receipt, {}); // no expected settlement
  assert.equal(res.ok, false);
  assert.equal(res.stage, "bind");
  assert.match(res.reason, /^unbound/);
});

// Network-gated: bind + verify a REAL mainnet settlement on chain.
test("LIVE: delivery binds to a real on-chain BSV settlement", { skip: process.env.LIVE !== "1" }, async () => {
  const REAL = { settlementRef: "77030c6192c6e86b808f1d7afa210b874bad86ed6a6b4ef69a8ccebc51ec83c6", payTo: "1LdqUbdZ6GY71KxThU6aKfuKXxgmTn82cv", amountAtomic: 5942 };
  const receipt = deliveryReceipt(genKeypair(), { payloadId: "0xp", root, rail: "bsv", network: "bsv", ...REAL });
  const res = await verifyDeliveryLive(receipt, { settlementRef: REAL.settlementRef }, { minSats: REAL.amountAtomic, minConf: 1 });
  assert.equal(res.ok, true);
  assert.equal(res.settlement.paidSats >= 5942, true);
});
