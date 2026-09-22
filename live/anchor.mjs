// Provenance anchor: commit the manifest root to the chain in an OP_RETURN, so there
// is tamper-evident proof of what was captured, independent of every relay it crossed.
//
// verifyAnchorOnChain (zero dependency, WhatsOnChain): given an anchor txid and the
// root, confirm an OP_RETURN output of that tx carries the root. Read-only.
//
// buildAnchorTx (needs @bsv/sdk + a funded key): construct a signed OP_RETURN tx WITHOUT
// broadcasting. Broadcasting is a separate, deliberate step (a spend), done by the
// operator, not here.

const WOC = "https://api.whatsonchain.com/v1/bsv/main";
const strip0x = (h) => String(h).replace(/^0x/i, "").toLowerCase();

// Does `tx` carry `root` in an OP_RETURN? Pure, testable without the network.
export function opReturnCarriesRoot(txJson, root) {
  const needle = strip0x(root);
  for (const o of txJson.vout || []) {
    const spk = o.scriptPubKey || {};
    const hay = `${spk.hex || ""} ${spk.asm || ""}`.toLowerCase();
    const isNulldata = (spk.type === "nulldata") || /\bOP_RETURN\b/i.test(spk.asm || "") || /^006a|^6a/.test(spk.hex || "");
    if (isNulldata && hay.includes(needle)) return true;
  }
  return false;
}

export async function verifyAnchorOnChain(txid, root, { minConf = 0 } = {}) {
  if (!txid || !root) return { ok: false, reason: "need txid and root" };
  let j;
  try { j = await (await fetch(`${WOC}/tx/hash/${txid}`)).json(); }
  catch (e) { return { ok: false, reason: `chain_read_failed: ${e.message}`, txid }; }
  const carries = opReturnCarriesRoot(j, root);
  const confirmations = Number(j.confirmations) || 0;
  const ok = carries && confirmations >= minConf;
  return { ok, txid, root: strip0x(root), confirmations, reason: ok ? undefined : (carries ? "insufficient_confirmations" : "root_not_in_op_return") };
}

// Build (do NOT broadcast) a signed OP_RETURN tx anchoring `root`. Requires @bsv/sdk and
// a funded key (a WIF, or a PrivateKey via `priv`). Returns { txhex, txid, address }.
// The operator broadcasts txhex; this function never touches the network to send.
export async function buildAnchorTx({ root, wif, priv: privIn, wocBase = WOC }) {
  let sdk;
  try { sdk = await import("@bsv/sdk"); }
  catch { throw new Error("buildAnchorTx needs @bsv/sdk: `npm i @bsv/sdk` (or anchor via the existing BSVKey on-chain tooling)"); }
  const { PrivateKey, Transaction, P2PKH, Script, Utils } = sdk;
  const priv = privIn || PrivateKey.fromWif(wif);
  const address = priv.toPublicKey().toAddress();
  const unspent = await (await fetch(`${wocBase}/address/${address}/unspent`)).json();
  if (!unspent || !unspent.length) throw new Error(`unfunded: ${address}`);

  const tx = new Transaction();
  // OP_FALSE OP_RETURN <root bytes>
  const rootBytes = Utils.toArray(strip0x(root), "hex");
  const asm = `OP_FALSE OP_RETURN ${Buffer.from(rootBytes).toString("hex")}`;
  tx.addOutput({ lockingScript: Script.fromASM(asm), satoshis: 0 });

  let inSats = 0;
  for (const u of unspent.sort((a, b) => b.value - a.value)) {
    const hex = await (await fetch(`${wocBase}/tx/${u.tx_hash}/hex`)).text();
    tx.addInput({ sourceTransaction: Transaction.fromHex(hex.trim()), sourceOutputIndex: u.tx_pos, unlockingScriptTemplate: new P2PKH().unlock(priv) });
    inSats += u.value;
    if (inSats > 500) break;
  }
  tx.addOutput({ lockingScript: new P2PKH().lock(priv.toPublicKey().toHash()), change: true });
  await tx.fee();
  await tx.sign();
  return { txhex: Utils.toHex(tx.toBinary()), txid: tx.id("hex"), address };
}
