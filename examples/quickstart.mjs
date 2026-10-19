// Quickstart: a payload crosses two relays to a destination that verifies every chunk
// and the custody chain, then binds delivery to the payment it made. No transport, no
// network, no dependencies: plug your own BPv7 node in where the comments say so.
//
//   node examples/quickstart.mjs
import { genKeypair, prepare, makeRelay, makeDest } from "../index.mjs";

// 1. Identities. In production each node keeps its own key (exportKeypair/importKeypair)
//    and the destination learns the others' public keys out of band.
const source = genKeypair(), relayA = genKeypair(), relayB = genKeypair(), dest = genKeypair();
const A = "dtn://relay-a/", B = "dtn://relay-b/";

// 2. Source: chunk the payload, commit it to a Merkle root, sign the manifest.
const payload = Buffer.from("field clinic report: 42 patients seen, 3 referrals, vaccine stock low. ".repeat(20));
const { manifest, bundles } = prepare(source, payload, { payloadId: "clinic-report-001", chunkSize: 256 });

// 3. Relays: each signs a custody receipt as it forwards a bundle. Your BPv7 node hands
//    the bundle to stamp() on receipt; the receipts travel with it (block 224) or beside it.
const hopA = makeRelay(relayA, A), hopB = makeRelay(relayB, B);
const t = Date.now();
const custody = new Map(bundles.map((b) => [b.bundleId, [
  hopA.stamp(b, "dtn://source/", t, t + 10),
  hopB.stamp(b, A, t + 20, t + 30),
]]));

// 4. Destination: pin the keys it trusts, verify chunks in any order, check custody.
const rx = makeDest(dest, manifest, [{ eid: A, pub: relayA.pub }, { eid: B, pub: relayB.pub }], { sourcePub: source.pub });
for (const b of [...bundles].reverse()) { // arrival order does not matter
  if (!rx.receiveBundle(b).ok) throw new Error(`chunk ${b.index} failed verification`);
  for (const r of custody.get(b.bundleId)) rx.recordCustody(b.bundleId, r);
}
const chainsOk = bundles.every((b) => rx.verifyChain(b.bundleId).ok);
const intact = rx.reassemble().equals(payload);

// 5. Settlement: the receipt names the txid the destination paid; binding refuses any other.
//    In production settlementRef comes from your own BSV payment (see live/).
const settlementRef = "0x" + "ab".repeat(32);
const { receipt, bind } = rx.settle(dest, {
  payloadId: manifest.payloadId, root: manifest.root, rail: "bsv", network: "bsv",
  settlementRef, payTo: "1LdqUbdZ6GY71KxThU6aKfuKXxgmTn82cv", amountAtomic: 1000,
}, { settlementRef });

console.log(`chunks verified:   ${bundles.length}/${manifest.chunkCount}`);
console.log(`custody chains:    ${chainsOk ? "all intact" : "BROKEN"}`);
console.log(`payload intact:    ${intact}`);
console.log(`delivery bound:    ${bind.ok} (receipt ${receipt.claimId.slice(0, 16)}...)`);
if (!(chainsOk && intact && bind.ok)) process.exit(1);
