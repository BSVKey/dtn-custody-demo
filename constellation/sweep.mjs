#!/usr/bin/env node
// Collect back what a payment run (ttn-run.mjs) paid to the satellites' payout addresses.
//
// The payout keys are derived from the funding key (payout.mjs), so the run's own state file
// says exactly which outputs exist: for every paid receipt, its transaction, output index,
// amount, and the payout key. No address scanning is needed. Before building anything, a
// sample of those transactions is fetched and each payout output is checked against the
// script derived here, so a wrong key or scheme is caught before a transaction is signed.
//
//   node constellation/sweep.mjs [--network=mainnet] [--state=<file>] --dry-run
//   node constellation/sweep.mjs --network=mainnet --spend-real-bsv [--to=<address>]
//
// Options: --to (default: the funding address), --per-tx=500 inputs per sweep transaction,
// --limit=N inputs (default all), --rate=<sat/kB> (default: the broadcaster's policy, at least 1).
// Sweep only after the run's payments are mined. Mainnet coins are real: sending needs
// --spend-real-bsv. Funding keys are read from the git-ignored .wif files and never printed.
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { PrivateKey, Transaction, P2PKH } from "@bsv/sdk";
import { payoutDeriver } from "./payout.mjs";

const arg = (k, d) => process.argv.find((a) => a.startsWith(`--${k}=`))?.split("=")[1] ?? d;
const has = (k) => process.argv.includes(`--${k}`);
const fmt = (n) => Math.round(n).toLocaleString("en-US");
const NET = arg("network", "teratestnet");
if (!["teratestnet", "mainnet"].includes(NET)) { console.error("--network must be teratestnet or mainnet"); process.exit(2); }
const MAIN = NET === "mainnet";
const DRY = has("dry-run");
if (MAIN && !DRY && !has("spend-real-bsv")) { console.error("refusing to send on MAINNET without --spend-real-bsv"); process.exit(2); }
const BROADCAST = process.env.ARCADE_URL || (MAIN ? "https://arc.gorillapool.io" : "https://arcade-ttn-us-1.bsvblockchain.tech");
const TXPATH = MAIN ? "/v1/tx" : "/tx";
const ASSET = process.env.ASSET_URL || (MAIN ? "https://api.whatsonchain.com/v1/bsv/main" : "https://ttn.cls9.com/api/v1");
const stateFile = arg("state", fileURLToPath(new URL(MAIN ? "./.main-state.json" : "./.ttn-state.json", import.meta.url)));
const st = JSON.parse(readFileSync(stateFile, "utf8"));
if ((st.network || "teratestnet") !== NET) { console.error(`state file is for ${st.network || "teratestnet"}, not ${NET}`); process.exit(2); }
const scheme = st.payout || "per-node"; // runs before the --payout option used one key per node

const funder = PrivateKey.fromWif(readFileSync(new URL(MAIN ? "./main-funding.wif" : "./ttn-funding.wif", import.meta.url), "utf8").trim());
const prefix = MAIN ? [0x00] : [0x6f];
const to = arg("to", funder.toPublicKey().toAddress(prefix));
const payoutOf = payoutDeriver(funder, scheme);

async function getText(url) {
  const r = await fetch(url, { signal: AbortSignal.timeout(20000) });
  return r.ok ? (await r.text()).trim().replace(/^"|"$/g, "") : null;
}
const parseTx = (hex) => (hex.slice(8, 20).toLowerCase() === "0000000000ef" ? Transaction.fromHexEF(hex) : Transaction.fromHex(hex));

// ---- What to collect -----------------------------------------------------------------------------
const limit = Number(arg("limit", st.paid.length));
const utxos = st.paid.slice(0, limit).map((p) => {
  const key = payoutOf(p.thisHop, p.claimId);
  return { txid: p.txid, vout: p.vout ?? 0, sats: st.pay, key, script: new P2PKH().lock(key.toPublicKey().toHash()) };
});
const total = utxos.reduce((a, u) => a + u.sats, 0);
console.log(`${MAIN ? "MAINNET" : "teratestnet"}: ${fmt(utxos.length)} payout outputs (${scheme} keys) worth ${fmt(total)} sat from ${stateFile.split(/[\\/]/).pop()}, to ${to}`);

// ---- Check the derivation against the chain before signing anything ----------------------------
const sample = [...new Set([0, 1, Math.floor(utxos.length / 2), utxos.length - 2, utxos.length - 1].filter((i) => i >= 0 && i < utxos.length))];
for (const i of sample) {
  const u = utxos[i];
  const hex = await getText(`${ASSET}/tx/${u.txid}/hex`);
  if (!hex) { console.error(`cannot fetch ${u.txid} from ${ASSET}; is the run mined yet?`); process.exit(2); }
  const out = parseTx(hex).outputs[u.vout];
  if (!out || out.satoshis !== u.sats || out.lockingScript.toHex() !== u.script.toHex()) {
    console.error(`output ${u.txid}:${u.vout} is not paid to the derived payout key (scheme ${scheme}); refusing to sweep`);
    process.exit(2);
  }
}
console.log(`checked ${sample.length} payout outputs against the chain: derived keys match what was paid`);

// ---- Fee rate ----------------------------------------------------------------------------------
let rate = Number(arg("rate", 0));
if (!rate) {
  if (MAIN) {
    const r = await fetch(`${BROADCAST}/v1/policy`).then((x) => x.json()).catch(() => null);
    const mf = r?.policy?.miningFee;
    rate = mf ? (mf.satoshis / mf.bytes) * 1000 : 100;
  } else rate = 5; // teratestnet nodes enforce a minimum their policy omits
}
rate = Math.max(1, rate);

// ---- Build: many inputs per transaction, one output to the destination ---------------------------
const perTx = Number(arg("per-tx", 500));
const toScript = new P2PKH().lock(to);
const sweeps = [];
for (let i = 0; i < utxos.length; i += perTx) {
  const part = utxos.slice(i, i + perTx);
  const tx = new Transaction();
  for (const u of part) {
    tx.addInput({ sourceTXID: u.txid, sourceOutputIndex: u.vout, sequence: 0xffffffff,
      unlockingScriptTemplate: new P2PKH().unlock(u.key, "all", false, u.sats, u.script) });
  }
  const value = part.reduce((a, u) => a + u.sats, 0);
  const fee = Math.ceil((part.length * 148 + 34 + 10) * rate / 1000);
  if (value - fee < 1) { console.error(`sweep of ${part.length} outputs would cost more in fees (${fee}) than it collects (${value})`); process.exit(2); }
  tx.addOutput({ lockingScript: toScript, satoshis: value - fee });
  await tx.sign();
  sweeps.push({ tx, part, txid: tx.id("hex"), inputs: part.length, value, fee, bytes: tx.toBinary().length });
}
const fees = sweeps.reduce((a, s) => a + s.fee, 0);
const actualRate = Math.min(...sweeps.map((s) => (s.fee / s.bytes) * 1000));
console.log(`built and signed ${sweeps.length} sweep transactions at ${rate} sat/kB: collect ${fmt(total)} sat, fees ${fmt(fees)} sat, ${fmt(total - fees)} sat back to ${to} (lowest actual rate ${actualRate.toFixed(1)} sat/kB)`);
if (actualRate < rate * 0.98) { console.error("fee estimate fell short of the rate; refusing"); process.exit(1); }
if (DRY) { console.log("dry run: nothing sent"); process.exit(0); }

// Extended format (BRC-30) from what we already know about each input (its amount and locking
// script), so no parent transaction has to be fetched. Broadcasters need it to validate inputs
// they have not indexed.
function toHexEFKnown(tx, part) {
  const raw = Buffer.from(tx.toBinary());
  const varint = (n) => n < 0xfd ? Buffer.from([n]) : n <= 0xffff ? Buffer.from([0xfd, n & 0xff, n >> 8]) : (() => { const b = Buffer.alloc(5); b[0] = 0xfe; b.writeUInt32LE(n, 1); return b; })();
  const readVar = (b, o) => { const f = b[o]; if (f < 0xfd) return [f, 1]; if (f === 0xfd) return [b.readUInt16LE(o + 1), 3]; return [b.readUInt32LE(o + 1), 5]; };
  let o = 4; const parts = [raw.subarray(0, 4), Buffer.from("0000000000ef", "hex")];
  const [nIn, l1] = readVar(raw, o); parts.push(raw.subarray(o, o + l1)); o += l1;
  for (let i = 0; i < nIn; i++) {
    const start = o; o += 36; const [sl, l2] = readVar(raw, o); o += l2 + sl + 4;
    parts.push(raw.subarray(start, o));
    const sats = Buffer.alloc(8); sats.writeBigUInt64LE(BigInt(part[i].sats));
    const scr = Buffer.from(part[i].script.toBinary());
    parts.push(sats, varint(scr.length), scr);
  }
  parts.push(raw.subarray(o));
  return Buffer.concat(parts).toString("hex");
}

// ---- Send ----------------------------------------------------------------------------------------
const sent = [], rejected = [];
for (const s of sweeps) {
  const r = await fetch(`${BROADCAST}${TXPATH}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ rawTx: toHexEFKnown(s.tx, s.part) }), signal: AbortSignal.timeout(60000) })
    .catch((e) => ({ ok: false, status: 0, text: async () => String(e) }));
  const text = await r.text();
  if (r.status >= 200 && r.status < 300) sent.push(s.txid); else rejected.push({ txid: s.txid, status: r.status, err: text.slice(0, 200) });
}
const out = new URL(MAIN ? "./.main-sweep.json" : "./.ttn-sweep.json", import.meta.url);
writeFileSync(out, JSON.stringify({ at: new Date().toISOString(), network: NET, to, rate, sent, rejected, total, fees }, null, 1));
console.log(`sent ${sent.length} of ${sweeps.length} sweep transactions, ${rejected.length} rejected${rejected.length ? ": " + JSON.stringify(rejected.slice(0, 2)) : ""}`);
process.exit(rejected.length ? 1 : 0);
