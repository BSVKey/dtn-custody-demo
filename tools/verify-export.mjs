#!/usr/bin/env node
// Verify a run exported from the browser evaluation (custody.bsvkey.com/try) with THIS
// repository's reference code: manifest signed by the pinned source key, every chunk against
// the Merkle root at its index, every custody chain against the pinned relay keys, the gap
// record, exact reassembly, and the delivery receipt bound to the stated payment reference.
//
//   node tools/verify-export.mjs custody-run.json
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { makeDest } from "../agent/dest.mjs";
import { verifyRecord, bindDelivery } from "../agent/lib/receipt.mjs";

const file = process.argv[2];
if (!file) {
  console.log("usage: node tools/verify-export.mjs <custody-run.json>");
  process.exit(0);
}
const run = JSON.parse(readFileSync(file, "utf8"));
const ok = (b) => (b ? "PASS" : "FAIL");
let fails = 0;
const check = (label, pass, extra = "") => { if (!pass) fails++; console.log(`  ${label.padEnd(44)} ${ok(pass)}${extra ? `  ${extra}` : ""}`); };

console.log(`Verifying ${file} (${run.plan?.name ?? "unknown plan"}) with the reference implementation`);
const hops = [{ eid: run.pins.relayaEid, pub: run.pins.relayaPub }, { eid: run.pins.relaybEid, pub: run.pins.relaybPub }];
let dest;
try {
  dest = makeDest({ priv: null, pub: "" }, run.manifest, hops, { sourcePub: run.pins.sourcePub });
  check("manifest signed by the pinned source key", true);
} catch (e) {
  check("manifest signed by the pinned source key", false, e.reason || e.message);
  process.exit(1);
}
let accepted = 0, chains = 0;
for (const b of run.bundles) {
  if (dest.receiveBundle(b).ok) accepted++;
  for (const r of run.custody[b.bundleId] || []) dest.recordCustody(b.bundleId, r);
  if (dest.verifyChain(b.bundleId).ok) chains++;
}
check(`chunks verified against the root (${accepted}/${run.bundles.length})`, accepted === run.bundles.length && dest.isComplete());
check(`custody chains verified (${chains}/${run.bundles.length})`, chains === run.bundles.length);
const payload = dest.isComplete() ? dest.reassemble() : Buffer.alloc(0);
check("payload reassembled exactly", createHash("sha256").update(payload).digest("hex") === run.payloadSha256);
check("gap record present with boundaries", run.gap?.kind === "gap/1" && run.gap.downAt !== null && run.gap.upAt !== null, `${run.gap?.bundlesDelayed?.length ?? 0} delayed`);
const dv = verifyRecord(run.delivery);
check("delivery receipt signed by the pinned destination", dv.ok && dv.signer === run.pins.destPub);
check("delivery bound to the stated payment reference", bindDelivery(run.delivery, { settlementRef: run.expectedSettlementRef }).ok);
console.log(fails === 0 ? "VERIFY: PASS" : `VERIFY: FAIL (${fails})`);
process.exit(fails ? 1 : 0);
