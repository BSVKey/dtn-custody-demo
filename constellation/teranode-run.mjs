#!/usr/bin/env node
// Constellation custody receipts and per-hop payments through a real Teranode node.
//
// REGTEST ONLY. The script refuses to run unless the node reports chain "regtest": coins are
// mined locally for the test and have no value, and nothing leaves the machine.
//
// 1. Fly the constellation (real orbits if a TLE cache exists, else the grid) and collect
//    every batch receipt: one per satellite per contact.
// 2. Mine regtest coins to a fresh local key, wait for coinbase maturity, and split them
//    into one funding output per payment.
// 3. For every batch receipt, submit one transaction that PAYS the relaying satellite's
//    payout address and COMMITS the receipt's claim id in an OP_RETURN, so each hop's
//    payment is bound to the custody it pays for. Measure submission throughput.
// 4. Also anchor one Merkle root per minute over all that minute's receipts (the cheap path).
// 5. Mine, then prove from the chain alone that sampled bundles had every hop both
//    custodied (receipt signature and inclusion) and paid (confirmed payment to that hop).
//
// Credentials: RPC_URL, RPC_USER, RPC_PASS from the environment (never printed).
//   RPC_USER=... RPC_PASS=... node constellation/teranode-run.mjs [--write] [--bundles=N]
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import os from "node:os";
import { PrivateKey, Transaction, P2PKH, Script, Utils } from "@bsv/sdk";
import { makeConstellation, simulate, verifyAll } from "./sim.mjs";
import { parseTles, makeOrbitalConstellation } from "./orbits.mjs";
import { batchProof } from "../agent/lib/batch.mjs";
import { verifyPath, pinnedDirectory, assemblePath } from "../agent/lib/path.mjs";
import { leafHash, buildTree } from "../agent/lib/merkle.mjs";
import { MOC } from "./sim.mjs";

const RPC = process.env.RPC_URL || "http://127.0.0.1:9292";
const AUTH = "Basic " + Buffer.from(`${process.env.RPC_USER}:${process.env.RPC_PASS}`).toString("base64");
const arg = (k, d) => process.argv.find((a) => a.startsWith(`--${k}=`))?.split("=")[1] ?? d;
const fmt = (n) => Math.round(n).toLocaleString("en-US");
let rpcId = 0;
async function rpc(method, params = []) {
  const r = await fetch(RPC, { method: "POST", headers: { authorization: AUTH, "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "1.0", id: ++rpcId, method, params }) });
  const j = await r.json().catch(() => ({ error: { message: `HTTP ${r.status}` } }));
  if (j.error) throw new Error(`${method}: ${j.error.message || JSON.stringify(j.error)}`);
  return j.result;
}
async function pool(items, n, fn) {
  let i = 0; const out = new Array(items.length);
  await Promise.all(Array.from({ length: n }, async () => { while (i < items.length) { const k = i++; out[k] = await fn(items[k], k); } }));
  return out;
}

// ---- Safety: regtest only -------------------------------------------------------------------
const info = await rpc("getblockchaininfo");
if (info.chain !== "regtest") { console.error(`refusing to run: node reports chain "${info.chain}", not regtest`); process.exit(2); }
const startHeight = info.blocks;

// ---- 1. Constellation and its batch receipts -------------------------------------------------
const tleFile = new URL("./.tle-cache/starlink.tle", import.meta.url);
const bundles = Number(arg("bundles", 10000));
const c = existsSync(tleFile)
  ? makeOrbitalConstellation({ tles: parseTles(readFileSync(tleFile, "utf8")), count: 4032, startTime: new Date(Date.UTC(2026, 8, 30, 6, 0)) })
  : makeConstellation({});
const orbitsNote = existsSync(tleFile) ? "real orbits (public Starlink elements, SGP4)" : "grid model";
const run = simulate(c, { bundles, epochs: 40, ticksPerEpoch: 10 });
const base = verifyAll(c, run);
const batches = run.batches;

// Each satellite, station and operations node gets a secp256k1 payout key (its custody key is
// Ed25519; payment and custody keys are deliberately separate).
const payoutKey = new Map();
const payoutOf = (eid) => { if (!payoutKey.has(eid)) payoutKey.set(eid, PrivateKey.fromHex(createHash("sha256").update(`payout:${eid}`).digest("hex"))); return payoutKey.get(eid); };
const PAY = Number(arg("pay", 100)); // satoshis per hop

// ---- 2. Mine and split funds -----------------------------------------------------------------
const funder = PrivateKey.fromRandom();
const funderHash = funder.toPublicKey().toHash();
const funderAddr = funder.toPublicKey().toAddress([0x6f]);
const tMine = performance.now();
const mined = await rpc("generatetoaddress", [110, funderAddr]);
// Coinbases from the first 8 blocks are mature after 110 blocks. Teranode's getblock does not
// list transaction ids, so the coinbase comes from the node's asset API, and the output that
// pays our key is located (Teranode coinbases can have several outputs).
const ASSET = process.env.ASSET_URL || "http://127.0.0.1:8090/api/v1";
const assetJson = async (path) => { const r = await fetch(`${ASSET}/${path}`); if (!r.ok) throw new Error(`asset ${path}: HTTP ${r.status}`); return r.json(); };
const ourScript = new P2PKH().lock(funderHash).toHex();
const cbTxs = [];
for (const h of mined.slice(0, 8)) {
  const tx = Transaction.fromHex((await assetJson(`block/${h}/json`)).coinbase_tx.hex);
  const vout = tx.outputs.findIndex((o) => o.lockingScript.toHex() === ourScript);
  if (vout < 0) throw new Error(`coinbase of ${h} does not pay our key`);
  cbTxs.push({ tx, vout });
}
// 1,000 outputs per split: the node's policy caps signature operations per transaction, and
// each standard payment output counts toward it. Each split spends the previous one's change.
const perFan = 1000, need = batches.length;
const fanTxs = [];
let cb = 0;
for (let made = 0; made < need; made += perFan) {
  const n = Math.min(perFan, need - made);
  const prevFan = fanTxs.at(-1);
  const tx = new Transaction();
  tx.addInput(prevFan
    ? { sourceTransaction: prevFan, sourceOutputIndex: prevFan.outputs.length - 1, unlockingScriptTemplate: new P2PKH().unlock(funder) }
    : { sourceTransaction: cbTxs[cb].tx, sourceOutputIndex: cbTxs[cb++].vout, unlockingScriptTemplate: new P2PKH().unlock(funder) });
  for (let k = 0; k < n; k++) tx.addOutput({ lockingScript: new P2PKH().lock(funderHash), satoshis: PAY + 1 });
  tx.addOutput({ lockingScript: new P2PKH().lock(funderHash), change: true });
  await tx.fee(0);
  await tx.sign();
  fanTxs.push(tx);
}
for (const tx of fanTxs) await rpc("sendrawtransaction", [tx.toHex()]);
await rpc("generate", [1]);
const tFund = (performance.now() - tMine) / 1000;

// ---- 3. One paid, anchored transaction per batch receipt -------------------------------------
const tSign0 = performance.now();
const paid = [];
for (let i = 0; i < batches.length; i++) {
  const b = batches[i].receipt;
  const fan = fanTxs[Math.floor(i / perFan)], out = i % perFan;
  const tx = new Transaction();
  tx.addInput({ sourceTransaction: fan, sourceOutputIndex: out, unlockingScriptTemplate: new P2PKH().unlock(funder) });
  tx.addOutput({ lockingScript: new P2PKH().lock(payoutOf(b.thisHop).toPublicKey().toHash()), satoshis: PAY });
  tx.addOutput({ lockingScript: Script.fromASM(`OP_FALSE OP_RETURN ${Buffer.from("custody-batch/1").toString("hex")} ${b.claimId.slice(2)}`), satoshis: 0 });
  await tx.sign(); // input PAY+1, outputs PAY: 1 sat fee
  paid.push({ claimId: b.claimId, thisHop: b.thisHop, hex: tx.toHex(), txid: tx.id("hex"), bytes: tx.toBinary().length });
}
const tSign = (performance.now() - tSign0) / 1000;

// Submit with bounded concurrency; a busy node answers HTTP 503, which is retried with backoff.
const conc = Number(arg("concurrency", 16));
const rejected = [];
let retries = 0;
const send = async (hex) => {
  for (let attempt = 0; ; attempt++) {
    try { return await rpc("sendrawtransaction", [hex]); }
    catch (e) {
      if (!/HTTP 503/.test(e.message) || attempt >= 10) throw e;
      retries++;
      await new Promise((r) => setTimeout(r, 100 * 2 ** Math.min(attempt, 6)));
    }
  }
};
const tSend0 = performance.now();
await pool(paid, conc, async (p) => { try { await send(p.hex); } catch (e) { rejected.push({ txid: p.txid, err: e.message.slice(0, 120) }); } });
const tSend = (performance.now() - tSend0) / 1000;
const accepted = paid.length - rejected.length;

// ---- 4. The cheap path: one Merkle root per minute over that minute's receipts ---------------
const byEpoch = new Map();
for (const b of batches) { const e = b.receipt.contactId.split(":")[0]; (byEpoch.get(e) || byEpoch.set(e, []).get(e)).push(b.receipt.claimId.slice(2)); }
const epochRoots = [...byEpoch.entries()].map(([e, ids]) => ({ epoch: e, count: ids.length, root: buildTree(ids.sort().map((h) => leafHash(Buffer.from(h, "hex")))).root }));
const anchorFund = cbTxs[cb++];
let prev = anchorFund.tx, prevOut = anchorFund.vout;
const anchors = [];
for (const r of epochRoots) {
  const tx = new Transaction();
  tx.addInput({ sourceTransaction: prev, sourceOutputIndex: prevOut, unlockingScriptTemplate: new P2PKH().unlock(funder) });
  tx.addOutput({ lockingScript: Script.fromASM(`OP_FALSE OP_RETURN ${Buffer.from("custody-epoch/1").toString("hex")} ${r.root}`), satoshis: 0 });
  tx.addOutput({ lockingScript: new P2PKH().lock(funderHash), change: true });
  await tx.fee(0); await tx.sign();
  await rpc("sendrawtransaction", [tx.toHex()]);
  anchors.push({ ...r, txid: tx.id("hex"), bytes: tx.toBinary().length });
  prev = tx; prevOut = 1;
}

// ---- 5. Mine and prove from the chain --------------------------------------------------------
// Inclusion is read from the blocks themselves: each mined block's subtrees (Teranode's
// transaction batches inside a block) list the transaction ids it contains, via the node's
// asset API. This build's RPC has no gettxout or gettxoutproof.
const tMine2 = performance.now();
const expected = accepted + anchors.length;
const confirmed = new Set();
let minedBlocks = 0;
for (let round = 0; round < 30 && confirmed.size < expected; round++) {
  const [h] = await rpc("generate", [1]);
  minedBlocks++;
  await new Promise((r) => setTimeout(r, 1500));
  const blk = await assetJson(`block/${h}/json`);
  for (const st of blk.subtrees || []) {
    // Subtree listings are paginated (at most 100 per page); read every page.
    for (let offset = 0, total = Infinity; offset < total; offset += 100) {
      const sub = await assetJson(`subtree/${st}/json?offset=${offset}&limit=100`);
      total = sub.pagination?.totalRecords ?? 0;
      for (const n of sub.data?.Nodes || []) if (!/^f{64}$/.test(n.txid)) confirmed.add(n.txid);
    }
  }
}
const tConfirm = (performance.now() - tMine2) / 1000;
const confirmedTx = async (txid) => (confirmed.has(txid) ? await rpc("getrawtransaction", [txid, 1]).catch(() => null) : null);
const paidConfirmed = paid.filter((p) => confirmed.has(p.txid)).length;
const anchorsConfirmed = anchors.filter((a) => confirmed.has(a.txid)).length;

// Chain-only proof for a sample of bundles: every hop's receipt verifies (custody), and the
// chain holds a confirmed transaction paying that hop's payout address and committing that
// exact receipt (payment bound to custody).
const txOf = new Map(paid.map((p) => [p.claimId, p.txid]));
const dir = pinnedDirectory(new Map([...c.keys].map(([eid, kp]) => [eid, kp.pub])));
const byBundle = new Map();
for (const b of batches) for (const id of b.leaves) (byBundle.get(id) || byBundle.set(id, []).get(id)).push(b);
const sample = run.delivered.filter((_, k) => k % Math.max(1, Math.floor(run.delivered.length / 100)) === 0).slice(0, 100);
let proven = 0, hopsChecked = 0;
const problems = {};
for (const d of sample) {
  const path = assemblePath(byBundle.get(d.bundleId).map((b) => ({ receipt: b.receipt, proof: batchProof(b, d.bundleId) })), d.source);
  const v = verifyPath(path, { bundleId: d.bundleId, source: d.source, destination: MOC, authorize: dir, maxHops: 256 });
  let ok = v.ok;
  for (const link of path) {
    const txid = txOf.get(link.receipt.claimId);
    const onchain = txid && await confirmedTx(txid);
    const pays = onchain && onchain.vout.some((o) => Math.round(o.value * 1e8) === PAY && (o.scriptPubKey.hex || "").includes(Buffer.from(payoutOf(link.receipt.thisHop).toPublicKey().toHash()).toString("hex")));
    const commits = onchain && onchain.vout.some((o) => (o.scriptPubKey.hex || "").includes(link.receipt.claimId.slice(2)));
    const inBlock = !!onchain;
    hopsChecked++;
    if (!(pays && commits && inBlock)) { ok = false; const why = !onchain ? "tx_missing" : !pays ? "hop_not_paid" : !commits ? "receipt_not_committed" : "unconfirmed"; problems[why] = (problems[why] || 0) + 1; }
  }
  if (ok) proven++;
}
const endHeight = (await rpc("getblockchaininfo")).blocks;

const avgBytes = paid.reduce((a, p) => a + p.bytes, 0) / paid.length;
const ok = rejected.length === 0 && paidConfirmed === accepted && anchorsConfirmed === anchors.length && proven === sample.length && base.failed === 0;
const lines = [
  `# Custody receipts and per-hop payments through Teranode: ${fmt(c.sats.length)} satellites`, "",
  `Run ${new Date().toISOString().slice(0, 10)} on ${os.cpus()[0].model.trim()}, Node ${process.version}. Teranode (BSV) on a **private local regtest chain**: coins were mined for the test and have no value; nothing was sent to any public network. Reproduce against a Teranode regtest node: \`RPC_USER=... RPC_PASS=... node constellation/teranode-run.mjs\`.`, "",
  "## What went on chain", "",
  "| | |", "|---|---|",
  `| Constellation | ${fmt(c.sats.length)} satellites, ${orbitsNote}; ${fmt(run.delivered.length)} bundles delivered, ${fmt(base.verified)} verified off chain |`,
  `| Batch receipts (one per satellite per contact) | ${fmt(batches.length)} |`,
  `| Paid, anchored transactions (one per batch receipt: pays the relaying satellite ${PAY} sat and commits the receipt id) | ${fmt(paid.length)} submitted, ${fmt(rejected.length)} rejected, ${fmt(paidConfirmed)} confirmed |`,
  `| Average transaction size | ${avgBytes.toFixed(0)} bytes |`,
  `| Per-minute anchors (one Merkle root over each minute's receipts) | ${anchors.length} transactions covering ${fmt(epochRoots.reduce((a, r) => a + r.count, 0))} receipts, ${anchorsConfirmed} confirmed |`,
  `| Blocks | ${startHeight} to ${endHeight}; inclusion read from each block's subtree transaction lists |`, "",
  "## Timing", "",
  "| Step | Time | Rate |", "|---|---|---|",
  `| Mine and split funds (110 blocks, ${fanTxs.length} fan-out transactions) | ${tFund.toFixed(1)} s | |`,
  `| Build and sign ${fmt(paid.length)} payment transactions (JavaScript, one thread) | ${tSign.toFixed(1)} s | ${fmt(paid.length / tSign)} per second |`,
  `| Submit to Teranode over JSON-RPC (${conc} concurrent, ${fmt(retries)} busy retries) | ${tSend.toFixed(1)} s | **${fmt(accepted / tSend)} accepted per second** |`,
  `| Mine until all confirmed (${minedBlocks} blocks) | ${tConfirm.toFixed(1)} s | |`, "",
  "Throughput here is bounded by one JSON-RPC client on one desktop running every Teranode service in Docker, not by Teranode's design capacity; treat it as a floor for this setup.", "",
  "## Proven from the chain", "",
  `For ${sample.length} sampled bundles (${fmt(hopsChecked)} hops), each hop's custody receipt verified and the chain held a confirmed transaction paying that hop's own payout address and committing that exact receipt: **${proven} of ${sample.length} bundles fully custodied and paid**${Object.keys(problems).length ? ` (problems: ${JSON.stringify(problems)})` : ""}.`, "",
  "## What it costs", "",
  `At the mainnet relay floor of 100 sat/kB (see docs of the quickstart), one paid, anchored receipt of about ${avgBytes.toFixed(0)} bytes costs about ${(avgBytes * 0.1).toFixed(0)} satoshi in fees, and a per-minute anchor about ${(anchors[0].bytes * 0.1).toFixed(0)} satoshi. Anchoring only the per-minute roots, a whole constellation's custody costs ${anchors.length} small transactions per ${anchors.length} minutes.`, "",
  "## Limits", "",
  "- Regtest on one machine: no network propagation, no competing load, no real fees. Mainnet and teratestnet behaviour will differ.",
  "- Payments are simulated micropayments from one funding key to per-node payout addresses; the Operator Edition's non-custodial statements are the production settlement path.",
];
const text = lines.join("\n") + "\n";
console.log(text);
if (rejected.length) console.log("first rejections:", rejected.slice(0, 3));
console.log(`TERANODE_RESULT ${JSON.stringify({ ok, batches: batches.length, confirmed: paidConfirmed, perSecond: +(accepted / tSend).toFixed(1), proven })}`);
if (process.argv.includes("--write")) writeFileSync(new URL("./TERANODE-RESULTS.md", import.meta.url), text);
process.exit(ok ? 0 : 1);
