// Build (and SIGN, but do NOT broadcast) the provenance-anchor transaction that commits
// the manifest root to the BSV chain in an OP_RETURN. Claude builds and signs; the
// operator broadcasts. No funds move until you broadcast the printed txhex.
//
// Usage: WALLET_JSON="/path/to/throwaway-wallet.json" node live/build-anchor.mjs
//        (optional) MANIFEST_ROOT=0x<64hex> to anchor a specific root instead of the
//        deterministic root of live/anchored-payload.txt.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { Mnemonic, HD } from "@bsv/sdk";
import { leafHash, buildTree } from "../agent/lib/merkle.mjs";
import { chunk } from "../agent/source.mjs";
import { buildAnchorTx } from "./anchor.mjs";

const here = dirname(fileURLToPath(import.meta.url));

// Deterministic manifest root of the fixed anchored payload (no key needed for a root).
function rootOfPayload() {
  const bytes = readFileSync(join(here, "anchored-payload.txt"));
  const leaves = chunk(bytes, 64).map((c) => leafHash(c));
  return "0x" + buildTree(leaves).root;
}

const walletPath = process.env.WALLET_JSON;
if (!walletPath) { console.error("set WALLET_JSON to the throwaway wallet json path"); process.exit(2); }
const wallet = JSON.parse(readFileSync(walletPath, "utf8"));

// Derive the signing key from the throwaway mnemonic (same path the wallet declares).
const seed = Mnemonic.fromString(wallet.mnemonic).toSeed();
const priv = HD.fromSeed(seed).derive(wallet.derivation || "m/44'/236'/0'/0/0").privKey;

const root = process.env.MANIFEST_ROOT || rootOfPayload();

console.log("== Anchor build (sign only, NOT broadcast) ==");
console.log("  wallet address :", wallet.address);
console.log("  manifest root  :", root);

const { txhex, txid, address } = await buildAnchorTx({ root, priv });
if (address !== wallet.address) console.log("  NOTE derived address:", address, "(differs from wallet.address; check derivation)");

console.log("  built txid     :", txid);
console.log("\n  SIGNED TX HEX (broadcast this yourself; nothing is sent until you do):\n");
console.log(txhex);
console.log("\n  Broadcast, e.g.:");
console.log(`    curl -sS -X POST https://api.whatsonchain.com/v1/bsv/main/tx/raw -H "Content-Type: application/json" -d '{"txhex":"${txhex.slice(0, 24)}..."}'`);
console.log("  (full txhex above). Then verify the anchor:");
console.log(`    ANCHOR_TXID=${txid} MANIFEST_ROOT=${root} node live/run-live.mjs`);
