// Load a wallet to send real Bitcoin BSV: a private key (WIF), a 12-24 word recovery phrase, or a
// wallet file (BSVKey's export: { mnemonic, derivation, address }, or any JSON with a wif). The key
// is only ever held in memory by the caller.
//
// Coins come from WhatsOnChain while online (fetchCoins); signing needs no network after that.
import { PrivateKey, Transaction, P2PKH, Mnemonic, HD } from "@bsv/sdk";

export const DEFAULT_PATH = "m/44'/236'/0'/0/0"; // BIP44, coin type 236 (Bitcoin BSV)
export const WOC = "https://api.whatsonchain.com/v1/bsv/main";
const WIF = /^[5KL][1-9A-HJ-NP-Za-km-z]{50,51}$/;

function fromPhrase(phrase, path) {
  const words = phrase.trim().toLowerCase().split(/\s+/);
  if (![12, 15, 18, 21, 24].includes(words.length)) throw new Error(`a recovery phrase has 12, 15, 18, 21 or 24 words, not ${words.length}`);
  let m;
  try { m = Mnemonic.fromString(words.join(" ")); } catch { throw new Error("that recovery phrase does not check out: a word may be misspelled or out of order"); }
  return HD.fromSeed(m.toSeed()).derive(path).privKey;
}

// returns { key, address, kind, path? }; throws with a plain reason
export function importWallet(input, { path = DEFAULT_PATH } = {}) {
  const t = String(input ?? "").trim();
  if (!t) throw new Error("paste a private key or recovery phrase, or choose a wallet file");
  if (t.startsWith("{")) {
    let j;
    try { j = JSON.parse(t); } catch { throw new Error("that file is not a wallet file this page can read"); }
    const wif = j.wif ?? j.WIF ?? j.privateKey ?? j.privKey;
    let key, kind, p;
    if (typeof wif === "string" && WIF.test(wif.trim())) { key = PrivateKey.fromWif(wif.trim()); kind = "wallet file (key)"; }
    else if (typeof j.mnemonic === "string") { p = j.derivation || j.path || path; key = fromPhrase(j.mnemonic, p); kind = "wallet file (recovery phrase)"; }
    else throw new Error("no key or recovery phrase found in that file");
    const address = key.toAddress();
    if (j.address && j.address !== address) throw new Error(`that file says its address is ${j.address}, but its key gives ${address}: not loaded`);
    return { key, address, kind, path: p };
  }
  if (WIF.test(t)) { try { const key = PrivateKey.fromWif(t); return { key, address: key.toAddress(), kind: "private key" }; } catch { throw new Error("that private key does not check out"); } }
  const key = fromPhrase(t, path);
  return { key, address: key.toAddress(), kind: "recovery phrase", path };
}

// Unspent coins of an address with their parent transactions, largest first (confirmed and
// unconfirmed). get(url) -> Response, so tests can stand in for the network.
export async function fetchCoins(address, { get = (u) => fetch(u), max = 25 } = {}) {
  // unspent/all: confirmed and unconfirmed in one answer, and an empty list (not a 404, whose
  // reply browsers can block) for an address WhatsOnChain has never seen
  const r = await get(`${WOC}/address/${address}/unspent/all`);
  if (r.status === 404) return [];
  if (!r.ok) throw new Error(`WhatsOnChain did not answer (${r.status})`);
  const lists = [((await r.json()).result ?? []).filter((u) => !u.isSpentInMempoolTx)];
  const seen = new Set(), utxos = [];
  for (const u of lists.flat()) { const k = `${u.tx_hash}:${u.tx_pos}`; if (!seen.has(k)) { seen.add(k); utxos.push(u); } }
  utxos.sort((a, b) => b.value - a.value);
  const coins = [];
  for (const u of utxos.slice(0, max)) {
    const r = await get(`${WOC}/tx/${u.tx_hash}/hex`);
    if (!r.ok) throw new Error(`could not fetch transaction ${u.tx_hash}`);
    const tx = Transaction.fromHex((await r.text()).trim());
    if (tx.id("hex") !== u.tx_hash || tx.outputs[u.tx_pos]?.satoshis !== u.value) throw new Error(`transaction ${u.tx_hash} does not match what WhatsOnChain listed`);
    coins.push({ tx, vout: u.tx_pos, sats: u.value });
  }
  return coins;
}

// Spend just enough of `coins` (largest first) to pay `sats` to `to`, change back to the key.
export async function buildFromCoins({ key, coins, to, sats, feeRate = 100 }) {
  sats = Math.floor(Number(sats));
  if (!(sats > 0)) throw new Error("give an amount in satoshis");
  new P2PKH().lock(to); // throws on a bad address
  const ours = new P2PKH().lock(key.toAddress()).toHex();
  const mine = coins.filter((c) => c.tx.outputs[c.vout]?.lockingScript.toHex() === ours).sort((a, b) => b.sats - a.sats);
  const total = mine.reduce((s, c) => s + c.sats, 0);
  // fee worked out here, not by the SDK: it would quietly drop a change output it cannot fund
  const feeFor = (inputs) => Math.ceil(((10 + inputs * 148 + 2 * 34) * feeRate) / 1000);
  let picked = [], have = 0;
  for (const c of mine) { picked.push(c); have += c.sats; if (have >= sats + feeFor(picked.length)) break; }
  const change = have - sats - feeFor(picked.length);
  if (change < 0) throw new Error(`not enough: you have ${total} sat, and this needs ${sats} sat plus a ${feeFor(picked.length)} sat fee`);
  const tx = new Transaction();
  for (const c of picked) tx.addInput({ sourceTransaction: c.tx, sourceOutputIndex: c.vout, unlockingScriptTemplate: new P2PKH().unlock(key) });
  tx.addOutput({ lockingScript: new P2PKH().lock(to), satoshis: sats });
  if (change > 0) tx.addOutput({ lockingScript: new P2PKH().lock(key.toAddress()), satoshis: change });
  await tx.sign();
  return tx;
}
