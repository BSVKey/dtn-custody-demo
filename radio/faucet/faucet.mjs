// A Bitcoin BSV faucet that can be announced over any link here: sound (speaker, walkie-talkie,
// AM/FM, phone call), LoRa, SMS, or a printed QR code.
//
// One funding transaction (the "fan-out") splits the faucet's money into equal coins, each locked
// to its own key derived from the faucet's master key. Then either:
//   claims mode   the faucet keeps the coin keys. People (or robots) send "BSV1 CLAIM <address>"
//                 by text or radio, and the faucet pays one coin per claimant, within limits, with a
//                 signed receipt.
//   bearer mode   the coin keys themselves are broadcast. Whoever hears one can sweep it to their
//                 own address, offline, and forward that payment later. Each coin can be claimed
//                 once: the first sweep the network accepts wins it, and later ones are refused.
//
// A coin must be worth more than the fee to claim it, or the claim would be refused. planFaucet()
// enforces that, and that the funding covers every coin plus the fan-out's own fee.
import { createHash } from "node:crypto";
import { PrivateKey, PublicKey, Signature, Transaction, P2PKH, Script, SatoshisPerKilobyte } from "@bsv/sdk";

export const SWEEP_BYTES = 191; // one P2PKH input, one P2PKH output
export const MAX_COINS = 1296; // two base-36 digits in a coin line
export const DEFAULT_MIN_COIN = 50;
const DOMAIN = "bsvkey-faucet/1";

export const feeFor = (bytes, feeRate) => Math.ceil((bytes * feeRate) / 1000);
export const sweepFee = (feeRate) => feeFor(SWEEP_BYTES, feeRate);
// fan-out: one input, `count` coins, one OP_RETURN, one change output
export const fanoutBytes = (count) => 10 + 148 + count * 34 + 60 + 34 + 9;

// coinSats with count or total. Throws with a plain reason when the faucet would not work.
export function planFaucet({ coinSats, count, total, feeRate = 100, minCoin = DEFAULT_MIN_COIN, fundSats } = {}) {
  coinSats = Math.floor(Number(coinSats));
  if (!(coinSats > 0)) throw new Error("give a coin size in satoshis");
  const claimFee = sweepFee(feeRate), floor = Math.max(minCoin, claimFee + 1);
  if (coinSats < floor) throw new Error(`coins of ${coinSats} sat are too small: claiming one costs about ${claimFee} sat at ${feeRate} sat/kB, so coins must be at least ${floor} sat`);
  if (count == null && total == null) throw new Error("give a coin count or a total");
  count = count != null ? Math.floor(Number(count)) : Math.floor(Number(total) / coinSats);
  if (!(count >= 1)) throw new Error(`a total of ${total} sat does not make one coin of ${coinSats} sat`);
  if (count > MAX_COINS) throw new Error(`at most ${MAX_COINS} coins per faucet; run another for more`);
  const coinsTotal = count * coinSats, fanoutFee = feeFor(fanoutBytes(count), feeRate), need = coinsTotal + fanoutFee;
  const plan = { coinSats, count, coinsTotal, fanoutFee, need, claimFee, received: coinSats - claimFee, feeRate, leftover: total != null ? Number(total) - coinsTotal : 0 };
  if (fundSats != null && fundSats < need) throw new Error(`the funding has ${fundSats} sat; ${count} coins of ${coinSats} sat plus a ${fanoutFee} sat fee need ${need} sat`);
  return plan;
}

const sha256 = (...parts) => createHash("sha256").update(Buffer.concat(parts.map((p) => Buffer.from(p)))).digest();
// A faucet is its master key plus the funding output it was made from ("txid:vout"), so one key
// can run many faucets and no two share a coin key (a bearer faucet's broadcast keys never unlock
// another faucet's coins).
export const faucetId = (master, funding) => sha256(Buffer.from(`${DOMAIN} ${funding}`), master.toPublicKey().encode(true)).toString("hex").slice(0, 8);

// coin i's key: sha256(domain | funding | master private key | i). Anyone with the master key can
// rebuild every coin; nobody with one coin key learns the others or the master key.
export function coinKey(master, funding, i) {
  const n = Buffer.alloc(4); n.writeUInt32BE(i);
  return PrivateKey.fromString(sha256(Buffer.from(`${DOMAIN}/coin ${funding}`), master.toArray("be", 32), n).toString("hex"), "hex");
}

// Build and sign the fan-out from a funding transaction that pays the master key. Never sends.
export async function buildFanout({ master, fundTx, coinSats, count, feeRate = 100, mode = "claims" }) {
  const ours = new P2PKH().lock(master.toAddress()).toHex();
  const vout = fundTx.outputs.findIndex((o) => o.lockingScript.toHex() === ours);
  if (vout < 0) throw new Error(`the funding transaction does not pay the faucet key ${master.toAddress()}`);
  const plan = planFaucet({ coinSats, count, feeRate, fundSats: fundTx.outputs[vout].satoshis });
  const funding = `${fundTx.id("hex")}:${vout}`, id = faucetId(master, funding);
  const tx = new Transaction();
  tx.addInput({ sourceTransaction: fundTx, sourceOutputIndex: vout, unlockingScriptTemplate: new P2PKH().unlock(master) });
  for (let i = 0; i < plan.count; i++) tx.addOutput({ lockingScript: new P2PKH().lock(coinKey(master, funding, i).toAddress()), satoshis: plan.coinSats });
  const tag = Buffer.from(`${DOMAIN} ${id} ${mode} ${plan.count}x${plan.coinSats}`).toString("hex");
  tx.addOutput({ lockingScript: Script.fromASM(`OP_FALSE OP_RETURN ${tag}`), satoshis: 0 });
  tx.addOutput({ lockingScript: new P2PKH().lock(master.toAddress()), change: true });
  await tx.fee(new SatoshisPerKilobyte(feeRate));
  await tx.sign();
  return { tx, plan, id, funding, coins: Array.from({ length: plan.count }, (_, i) => ({ i, vout: i, sats: plan.coinSats })) };
}

// Spend one coin (known by its outpoint and amount) to an address: amount = coin minus fee.
export async function spendCoin({ key, txid, vout, sats, to, feeRate = 100 }) {
  const lock = new P2PKH().lock(key.toAddress());
  const stub = new Transaction(); stub.outputs = []; stub.outputs[vout] = { lockingScript: lock, satoshis: sats };
  const tx = new Transaction();
  tx.addInput({ sourceTXID: txid, sourceTransaction: stub, sourceOutputIndex: vout, unlockingScriptTemplate: new P2PKH().unlock(key), sequence: 0xffffffff });
  tx.addOutput({ lockingScript: new P2PKH().lock(to), change: true });
  await tx.fee(new SatoshisPerKilobyte(feeRate));
  if (!(tx.outputs[0].satoshis > 0)) throw new Error(`a ${sats} sat coin does not cover the fee at ${feeRate} sat/kB`);
  await tx.sign();
  return tx;
}

// ---- bearer coin lines: F <index, 2 base-36> <WIF, 52> <txid, 64> <vout, 4 hex> <sats, 8 hex> ----
// 131 characters: fits one ggwave message, one SMS and one LoRa frame.
export function coinLine({ i, key, txid, vout, sats }) {
  const wif = key.toWif();
  if (wif.length !== 52) throw new Error("expected a compressed WIF");
  return `F${i.toString(36).padStart(2, "0")}${wif}${txid}${vout.toString(16).padStart(4, "0")}${sats.toString(16).padStart(8, "0")}`;
}

export function parseCoinLine(text) {
  const m = String(text ?? "").trim().match(/^F([0-9a-z]{2})([1-9A-HJ-NP-Za-km-z]{52})([0-9a-f]{64})([0-9a-f]{4})([0-9a-f]{8})$/);
  if (!m) return null;
  try { return { i: parseInt(m[1], 36), key: PrivateKey.fromWif(m[2]), txid: m[3], vout: parseInt(m[4], 16), sats: parseInt(m[5], 16) }; } catch { return null; }
}

export const sweepCoinLine = async (text, to, feeRate = 100) => {
  const c = parseCoinLine(text);
  if (!c) throw new Error("not a faucet coin line");
  return spendCoin({ ...c, to, feeRate });
};

// ---- announcements: one line each, plain text, under ggwave's 140 characters ----
export function announcement({ id, mode, coinSats, left, count, claimTo }) {
  return mode === "bearer"
    ? `BSVF1 ${id} bearer coins of ${coinSats} sat, ${left} of ${count}. First to sweep each one keeps it.`
    : `BSVF1 ${id} ${coinSats} sat each, ${left} of ${count} left. Send BSV1 CLAIM <your address>${claimTo ? ` to ${claimTo}` : ""}`;
}

export function parseAnnouncement(text) {
  const t = String(text ?? "").trim();
  let m = t.match(/^BSVF1 ([0-9a-f]{8}) (\d+) sat each, (\d+) of (\d+) left\. Send BSV1 CLAIM <your address>(?: to (\S+))?$/);
  if (m) return { id: m[1], mode: "claims", coinSats: +m[2], left: +m[3], count: +m[4], claimTo: m[5] ?? null };
  m = t.match(/^BSVF1 ([0-9a-f]{8}) bearer coins of (\d+) sat, (\d+) of (\d+)\./);
  return m ? { id: m[1], mode: "bearer", coinSats: +m[2], left: +m[3], count: +m[4] } : null;
}

// ---- claims: "BSV1 CLAIM <address>", or signed by a device key for per-device limits ----
export const claimMessage = (id, address) => `${DOMAIN} claim ${id} ${address}`;

export function claimText(address, { id, deviceKey } = {}) {
  if (!deviceKey) return `BSV1 CLAIM ${address}`;
  const sig = Buffer.from(deviceKey.sign(claimMessage(id, address), "utf8").toDER()).toString("base64");
  return `BSV1 CLAIM ${address} ${deviceKey.toPublicKey().toString()} ${sig}`;
}

export function parseClaim(text, id) {
  const m = String(text ?? "").trim().replace(/\s+/g, " ").match(/^BSV1 CLAIM (\S{1,100})(?: ([0-9a-f]{66}) ([A-Za-z0-9+/=]{60,120}))?$/i);
  if (!m) return null;
  const address = m[1];
  try { new P2PKH().lock(address); } catch { return { address, bad: "that is not a valid address" }; }
  if (!m[2]) return { address };
  try {
    const pub = PublicKey.fromString(m[2]);
    const sigOk = pub.verify(claimMessage(id, address), Signature.fromDER([...Buffer.from(m[3], "base64")]), "utf8");
    return sigOk ? { address, device: m[2] } : { address, bad: "the device signature does not match" };
  } catch { return { address, bad: "the device signature does not match" }; }
}
