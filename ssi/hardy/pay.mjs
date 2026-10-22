#!/usr/bin/env node
// Pay the operators of a Solar System Internet run on Bitcoin BSV, from the settlement
// statements the clearing house signed (ssi/settle.mjs, saved in report.json by report.mjs).
//
//   node ssi/hardy/pay.mjs --report <report.json> --fund=<txid>:<vout> --wif-file=<file>
//       check every statement, build and sign the payment; print it, send nothing
//   ... --spend-real-bsv
//       also broadcast it on BSV mainnet (ARC, live fee policy); judged by ARC's txStatus
//
// One output per operator, at an address derived from the funding key (HMAC, like the
// constellation payouts), so whoever holds the funding key can sweep the payments back; plus one
// OP_RETURN "ssi-settlement/1" with the Merkle root of the statement ids it pays, so each operator
// can tie its output to its signed statement. Amounts are in the run's abstract unit, converted at
// --sats-per-unit (default 10000). The key file is yours: it is read, never written or printed.
import { readFileSync } from "node:fs";
import { PrivateKey, Transaction, P2PKH, Script, SatoshisPerKilobyte } from "@bsv/sdk";
import { verifyRecord } from "../../agent/lib/receipt.mjs";
import { leafHash, buildTree } from "../../agent/lib/merkle.mjs";
import { arcVerdict } from "../../agent/lib/arc.mjs";
import { payoutDeriver } from "../../constellation/payout.mjs";

const ARC = process.env.ARC_URL || "https://arc.gorillapool.io";
const WOC = "https://api.whatsonchain.com/v1/bsv/main";

// Statements that verify, name an operator, and match the report's ledger. Throws otherwise.
export function payable(report, { satsPerUnit = 10000, clearingPub } = {}) {
  const rows = [];
  for (const [op, st] of Object.entries(report.statements || {})) {
    const v = verifyRecord(st);
    if (!v.ok) throw new Error(`statement for ${op} does not verify: ${v.reason}`);
    if (clearingPub && v.signer !== clearingPub) throw new Error(`statement for ${op} is not signed by the clearing house`);
    if (st.operator !== op || st.kind !== "ssi.settlement/1") throw new Error(`statement for ${op} names ${st.operator}`);
    const sats = Math.round(st.amount * satsPerUnit);
    if (sats >= 1) rows.push({ op, claimId: st.claimId, amount: st.amount, sats });
  }
  if (!rows.length) throw new Error("no statement with anything to pay");
  return rows;
}

export const statementsRoot = (rows) => buildTree(rows.map((r) => r.claimId).sort().map((id) => leafHash(Buffer.from(id, "utf8")))).root;

export async function buildPayment(rows, { funder, fundTx, vout, feeRate = 100 }) {
  const derive = payoutDeriver(funder, "per-node");
  const tx = new Transaction();
  tx.addInput({ sourceTransaction: fundTx, sourceOutputIndex: vout, unlockingScriptTemplate: new P2PKH().unlock(funder) });
  const paid = rows.map((r) => ({ ...r, payTo: derive(`ssi-operator:${r.op}`).toPublicKey().toAddress() }));
  for (const r of paid) tx.addOutput({ lockingScript: new P2PKH().lock(r.payTo), satoshis: r.sats });
  const root = statementsRoot(rows);
  tx.addOutput({ lockingScript: Script.fromASM(`OP_FALSE OP_RETURN ${Buffer.from("ssi-settlement/1").toString("hex")} ${root.replace(/^0x/, "")}`), satoshis: 0 });
  tx.addOutput({ lockingScript: new P2PKH().lock(funder.toPublicKey().toAddress()), change: true });
  await tx.fee(new SatoshisPerKilobyte(feeRate));
  const need = paid.reduce((s, r) => s + r.sats, 0);
  if (fundTx.outputs[vout].satoshis < need) throw new Error(`funding output has ${fundTx.outputs[vout].satoshis} sat; payments need ${need} plus fee`);
  await tx.sign();
  return { tx, paid, root };
}

if (process.argv[1]?.endsWith("pay.mjs")) {
  const arg = (k) => { const a = process.argv.find((x) => x.startsWith(`--${k}=`)); if (a) return a.slice(k.length + 3); const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : undefined; };
  const report = JSON.parse(readFileSync(arg("report"), "utf8"));
  const rows = payable(report, { satsPerUnit: Number(arg("sats-per-unit") || 10000), clearingPub: report.clearingPub });
  console.log(`statements verified: ${rows.map((r) => `${r.op} ${r.amount} -> ${r.sats} sat`).join(", ")}`);
  const fund = arg("fund"), wifFile = arg("wif-file");
  if (!fund || !wifFile) { console.log("plan only (add --fund=<txid>:<vout> --wif-file=<file> to build the payment)"); process.exit(0); }
  const [txid, voutS] = fund.split(":");
  const funder = PrivateKey.fromWif(readFileSync(wifFile, "utf8").trim());
  const hex = await fetch(`${WOC}/tx/${txid}/hex`).then((r) => { if (!r.ok) throw new Error(`funding tx ${txid}: HTTP ${r.status}`); return r.text(); });
  const fundTx = Transaction.fromHex(hex.trim());
  const pol = await fetch(`${ARC}/v1/policy`).then((r) => r.json()).catch(() => null);
  const feeRate = pol?.policy?.miningFee ? Math.ceil((pol.policy.miningFee.satoshis / pol.policy.miningFee.bytes) * 1000) : 100;
  const { tx, paid, root } = await buildPayment(rows, { funder, fundTx, vout: Number(voutS || 0), feeRate });
  for (const p of paid) console.log(`  ${p.op.padEnd(8)} ${String(p.sats).padStart(7)} sat -> ${p.payTo}`);
  console.log(`commitment (Merkle root of ${paid.length} statement ids): ${root}`);
  console.log(`txid ${tx.id("hex")}, fee ${tx.getFee()} sat at ${feeRate} sat/kB, ${tx.toHex().length / 2} bytes`);
  if (!process.argv.includes("--spend-real-bsv")) { console.log("NOT SENT (add --spend-real-bsv to broadcast on BSV mainnet)"); process.exit(0); }
  const r = await fetch(`${ARC}/v1/tx`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ rawTx: tx.toHexEF() }) });
  const v = arcVerdict(r.status, await r.text());
  console.log(v.ok ? `SENT ${tx.id("hex")} via ${ARC} (${v.txStatus})` : `NOT SENT: ${v.why}`);
  process.exit(v.ok ? 0 : 1);
}
