// Public entry point: the custody agent's API in one import. Zero dependencies; the
// live BSV paths (live/, constellation/) stay separate and are not exported here.
// The BPv7 side: Custody Receipt Block (type 224) receipts version 2 and offline key
// management (Key Record Block, type 225; spec/KEY-RECORDS.md).
//
//   import { genKeypair, prepare, makeRelay, makeDest } from "@bsvkey/dtn-custody";
//
// See docs/QUICKSTART.md and examples/quickstart.mjs.
export { prepare, chunk } from "./agent/source.mjs";
export { makeRelay } from "./agent/relay.mjs";
export { makeDest } from "./agent/dest.mjs";
export { genKeypair, exportKeypair, importKeypair, signClaim, verifySig } from "./agent/lib/keys.mjs";
export { leafHash, buildTree, proof, verifyProof } from "./agent/lib/merkle.mjs";
export { StreamMerkle, leafOf } from "./agent/lib/stream-merkle.mjs";
export {
  signRecord, verifyRecord, buildManifest, custodyReceipt, verifyCustodyChain,
  auditCustodyChain, deliveryReceipt, bindDelivery,
} from "./agent/lib/receipt.mjs";
export { BATCH_KIND, batchReceipt, batchProof, inBatch } from "./agent/lib/batch.mjs";
export { verifyPath, pinnedDirectory, assemblePath } from "./agent/lib/path.mjs";
export { gapObject } from "./agent/lib/gap.mjs";
export { canonicalize, sha256hex, contentId } from "./agent/lib/canonical.mjs";
export { encodeBundle, decodeBundle, BLOCK, BLOCK_FLAG } from "./transport/bpv7/bundle.mjs";
export { CUSTODY_BLOCK_TYPE } from "./transport/bpv7/custody-block.mjs";
export { stampBundleV2, verifyBundleV2, receiptFields, bundleIdentity } from "./transport/bpv7/receipt-v2.mjs";
export {
  Keyring, issueKey, revokeKey, recordFields, carryRecords, ingest, readKeyBlock, keyIdOf,
  KEY_BLOCK_TYPE, ROLE, KIND,
} from "./transport/bpv7/keyring.mjs";
