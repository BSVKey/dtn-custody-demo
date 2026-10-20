#!/usr/bin/env node
// Pay relay operators in BSV for the custody the hub verified.
//
//   node relief/kit/payout.mjs --config deploy/district-hub.json --data data/district-hub
//       plan only: what each relay is owed, from the hub's frame log (nothing is signed)
//   ... --fund=<txid> --wif-file=payout.wif
//       build and sign the payout transaction from that funding output; print it, send nothing
//   ... --fund=<txid> --wif-file=payout.wif --spend-real-bsv
//       also broadcast it on BSV mainnet (ARC, live fee policy) and record what it paid
//
// One output per relay at the payTo address in the deployment, plus one OP_RETURN committing to
// exactly which handoffs this transaction pays (the Merkle root of the paid bundle ids), so any
// relay can check its payment against the hub's evidence. Paid ids are kept in
// <data>/payouts.jsonl and never paid again. The funding key file is yours: this script reads it
// and never writes or prints it.
import { readFileSync, appendFileSync, existsSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, resolve } from "node:path";
import { PrivateKey, Transaction, P2PKH, Script, SatoshisPerKilobyte } from "@bsv/sdk";
import { importKeypair } from "../../agent/lib/keys.mjs";
import { leafHash, buildTree } from "../../agent/lib/merkle.mjs";
import { makeHub } from "./lib/roles.mjs";
import { arcVerdict } from "../../agent/lib/arc.mjs";

const ARC = process.env.ARC_URL || "https://arc.gorillapool.io";
const WOC = "https://api.whatsonchain.com/v1/bsv/main";
const MIN_OUTPUT = 1; // BSV has no dust limit; skip zero only

// Rebuild the hub's verified state from its frame log.
export function owed(config, dataDir) {
  const hub = makeHub({ kp: importKeypair(config.sign), eid: config.eid, encPriv: config.encPriv, directory: config.directory, ratePerBundleSats: config.ratePerBundleSats });
  const frames = join(dataDir, "frames.jsonl");
  if (existsSync(frames)) for (const line of readFileSync(frames, "utf8").split("\n")) if (line) { const { at, frame } = JSON.parse(line); hub.ingest(Buffer.from(frame, "base64"), at); }
  const already = new Set();
  const ledger = join(dataDir, "payouts.jsonl");
  if (existsSync(ledger)) for (const line of readFileSync(ledger, "utf8").split("\n")) if (line) for (const p of JSON.parse(line).paid) for (const id of p.bundleIds) already.add(`${p.relay} ${id}`);
  const rate = config.ratePerBundleSats ?? 50;
  const rows = Object.entries(hub.paidIds()).map(([relay, ids]) => {
    const due = ids.filter((id) => !already.has(`${relay} ${id}`));
    return { relay, payTo: config.directory.payTo?.[relay] ?? null, bundleIds: due, sats: due.length * rate };
  }).filter((r) => r.bundleIds.length);
  return { rows, rate };
}

// The commitment: Merkle root over "relay bundleId" for every handoff this transaction pays.
export function commitment(rows) {
  const leaves = rows.flatMap((r) => r.bundleIds.map((id) => `${r.relay} ${id}`)).sort();
  return leaves.length ? buildTree(leaves.map((l) => leafHash(Buffer.from(l, "utf8")))).root : null;
}

// Build and sign. fundTx is the funding transaction, vout its output paying the funder.
export async function buildPayout(rows, { funder, fundTx, vout, feeRate = 100, network = "main" }) {
  const payable = rows.filter((r) => r.payTo && r.sats >= MIN_OUTPUT);
  if (!payable.length) throw new Error("nothing payable: no relay with a payTo address is owed anything");
  const tx = new Transaction();
  tx.addInput({ sourceTransaction: fundTx, sourceOutputIndex: vout, unlockingScriptTemplate: new P2PKH().unlock(funder) });
  for (const r of payable) tx.addOutput({ lockingScript: new P2PKH().lock(r.payTo), satoshis: r.sats });
  const root = commitment(payable);
  tx.addOutput({ lockingScript: Script.fromASM(`OP_FALSE OP_RETURN ${Buffer.from("relief-payout/1").toString("hex")} ${root}`), satoshis: 0 });
  tx.addOutput({ lockingScript: new P2PKH().lock(funder.toPublicKey().toAddress(network === "main" ? [0x00] : [0x6f])), change: true });
  await tx.fee(new SatoshisPerKilobyte(feeRate));
  const need = payable.reduce((s, r) => s + r.sats, 0);
  if (fundTx.outputs[vout].satoshis < need) throw new Error(`funding output has ${fundTx.outputs[vout].satoshis} sat; payouts need ${need} plus fee`);
  await tx.sign();
  return { tx, payable, root };
}

// Broadcast through ARC and record the payout as paid only if ARC accepted it. ARC can answer
// HTTP 200 for a transaction that will never be mined (an orphan or a double spend), so the
// txStatus decides (agent/lib/arc.mjs). Returns the verdict { ok, txStatus, why }.
export async function broadcastPayout({ tx, payable, root, dataDir, arc = ARC, fetchFn = fetch }) {
  const r = await fetchFn(`${arc}/v1/tx`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ rawTx: tx.toHexEF() }) });
  const v = arcVerdict(r.status, await r.text());
  if (v.ok) appendFileSync(join(dataDir, "payouts.jsonl"), JSON.stringify({ txid: tx.id("hex"), at: new Date().toISOString(), commitment: root, paid: payable.map(({ relay, payTo, bundleIds, sats }) => ({ relay, payTo, sats, bundleIds })) }) + "\n");
  return v;
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  const arg = (k) => { const a = process.argv.find((x) => x.startsWith(`--${k}=`)); if (a) return a.slice(k.length + 3); const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : undefined; };
  const has = (k) => process.argv.includes(`--${k}`);
  const config = JSON.parse(readFileSync(arg("config"), "utf8"));
  const dataDir = arg("data");
  if (config.role !== "hub" || !dataDir) { console.error("usage: node relief/kit/payout.mjs --config <hub.json> --data <hub data dir> [--fund=<txid> --wif-file=<file> [--spend-real-bsv]]"); process.exit(2); }
  const { rows, rate } = owed(config, dataDir);
  console.log(`owed at ${rate} sats per verified bundle (handoffs already paid are excluded):`);
  for (const r of rows) console.log(`  ${r.relay.padEnd(30)} ${String(r.bundleIds.length).padStart(6)} bundles  ${String(r.sats).padStart(9)} sats  ${r.payTo ?? "NO payTo ADDRESS in the deployment: not payable"}`);
  if (!rows.length) { console.log("  nothing owed"); process.exit(0); }
  console.log(`commitment (Merkle root of the paid handoffs): ${commitment(rows.filter((r) => r.payTo))}`);
  const fund = arg("fund");
  if (!fund) { console.log("plan only. Add --fund=<txid> --wif-file=<file> to build the transaction."); process.exit(0); }

  const funder = PrivateKey.fromWif(readFileSync(arg("wif-file"), "utf8").trim());
  const hex = await fetch(`${WOC}/tx/${fund}/hex`).then((r) => (r.ok ? r.text() : null));
  if (!hex) { console.error(`funding transaction ${fund} not found on mainnet`); process.exit(2); }
  const fundTx = Transaction.fromHex(hex.trim());
  const ours = new P2PKH().lock(funder.toPublicKey().toAddress()).toHex();
  const vout = fundTx.outputs.findIndex((o) => o.lockingScript.toHex() === ours);
  if (vout < 0) { console.error(`transaction ${fund} does not pay ${funder.toPublicKey().toAddress()}`); process.exit(2); }
  let feeRate = 100;
  const pol = await fetch(`${ARC}/v1/policy`).then((r) => r.json()).catch(() => null);
  const mf = pol?.policy?.miningFee;
  if (mf) feeRate = Math.max(1, (mf.satoshis / mf.bytes) * 1000);
  else if (has("spend-real-bsv")) { console.error(`refusing to send: no fee policy from ${ARC}`); process.exit(2); }
  const { tx, payable, root } = await buildPayout(rows, { funder, fundTx, vout, feeRate });
  console.log(`built ${tx.id("hex")}: ${payable.length} relay outputs, fee ${feeRate} sat/kB, commitment ${root}`);
  if (!has("spend-real-bsv")) { console.log(`not sent (add --spend-real-bsv to broadcast on MAINNET). raw tx:\n${tx.toHex()}`); process.exit(0); }
  const v = await broadcastPayout({ tx, payable, root, dataDir });
  if (!v.ok) { console.error(`NOT SENT, nothing recorded as paid: ${v.txStatus ? `${v.txStatus}, ` : ""}${v.why}`); process.exit(1); }
  console.log(`broadcast ${tx.id("hex")} via ${ARC} (${v.txStatus}); recorded in ${join(dataDir, "payouts.jsonl")}`);
}
