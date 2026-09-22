import { test } from "node:test";
import assert from "node:assert/strict";
import { genKeypair } from "../agent/lib/keys.mjs";
import { deliveryReceipt, bindDelivery, verifyRecord } from "../agent/lib/receipt.mjs";

const kp = genKeypair();
const settlementRef = "0x4e40b7bf86a0ca24f9746f3b6b5178def04b3a29024e4c7c9f8b95099ce380b8";
const rec = deliveryReceipt(kp, {
  payloadId: "0xrover-frame-001", root: "0x" + "a".repeat(64), rail: "bsv", network: "bsv",
  settlementRef, payTo: "1LdqUbdZ6GY71KxThU6aKfuKXxgmTn82cv", amountAtomic: 5942,
});

test("the delivery receipt is authentic", () => {
  assert.equal(verifyRecord(rec).ok, true);
});

test("bound to the txid the verifier paid: accepted", () => {
  assert.deepEqual(bindDelivery(rec, { settlementRef }), { ok: true });
});

test("bound to a different txid (replay/transfer): refused", () => {
  assert.equal(bindDelivery(rec, { settlementRef: "0x" + "9".repeat(64) }).reason, "settlementRef_not_mine");
});

test("unbound (no expected settlement): refused, not silently passed", () => {
  assert.match(bindDelivery(rec, {}).reason, /^unbound/);
  assert.match(bindDelivery(rec).reason, /^unbound/);
});

test("wrong payTo / understated amount refused", () => {
  assert.equal(bindDelivery(rec, { settlementRef, payTo: "1WrongAddrxxxxxxxxxxxxxxxxxxxxxxx" }).reason, "payTo_mismatch");
  assert.equal(bindDelivery(rec, { settlementRef, amountAtomic: 5941 }).reason, "amount_mismatch");
});
