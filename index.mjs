// Public entry point: the custody agent's API in one import. Zero dependencies; the
// live BSV paths (live/, constellation/) stay separate and are not exported here.
//
//   import { genKeypair, prepare, makeRelay, makeDest } from "dtn-custody-demo";
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
