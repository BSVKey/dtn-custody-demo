#!/usr/bin/env node
// Constellation custody receipts and per-hop payments on TERATESTNET, BSV's public Teranode
// test network, submitted through Arcade (the Teranode transaction broadcaster).
//
// Same flow as teranode-run.mjs (local regtest), on a shared public test network:
//   1. Fly the constellation and collect every batch receipt (one per satellite per contact).
//   2. Split the funding output into one input per payment (chained fan-out transactions).
//   3. For every batch receipt, submit one transaction that PAYS the relaying satellite's payout
//      address and COMMITS the receipt's claim id in an OP_RETURN.
//   4. Anchor one Merkle root per minute over that minute's receipts (the cheap path).
//   5. Later (--confirm): read each transaction's status and merkle proof from Arcade, check the
//      proof against block headers, and prove sampled bundles custodied and paid at every hop.
//
// Teratestnet coins have no value. The funding key is read from constellation/ttn-funding.wif
// (git-ignored) and never printed.
//
// --network=mainnet runs the same flow on Bitcoin BSV MAINNET through an ARC broadcaster
// (default GorillaPool), with the miner's live fee policy, a separate key
// (constellation/main-funding.wif), state (.main-state.json) and results (MAIN-RESULTS.md).
// Mainnet coins are real: sending requires --spend-real-bsv as well; dry runs and --confirm do not.
//
// Payout keys are derived with HMAC-SHA256 keyed by the funding key, so only the holder of the
// funding key can spend what the satellites are paid (and sweep it back).
//
//   node constellation/ttn-run.mjs --dry-run [--limit=N]          build and sign only, send nothing
//   node constellation/ttn-run.mjs --fund=<txid> --limit=50         small test batch
//   node constellation/ttn-run.mjs --fund=<txid>                    the full run
//   node constellation/ttn-run.mjs --confirm [--write]              check confirmations, write results
//   add --network=mainnet to any of these (and --spend-real-bsv to send)
//
// --broadcast=<url,...> sends every transaction through several broadcasters, the first being
// the primary (it must accept; its status is used by --confirm), the rest best effort. Each
// acceptance is counted: as Craig Wright puts it, assurance grows with how much of the hash
// power has been given the transaction, and one miner's backlog no longer holds a run up.
// Mainnet default: GorillaPool ARC, BSVA's mainnet Arcade, WhatsOnChain. Kinds are told apart by
// URL (arc: /v1/tx, arcade: /tx, whatsonchain: /tx/raw).
// --rebroadcast (with the run's original --fund and options) rebuilds the run's signed
// transactions, which are deterministic, checks every txid against the state file, and resends
// the ones not yet mined to every broadcaster. It creates no new payments.
//
// --batch=N (default 1) pays N receipts per transaction: one output per relaying satellite, in
// receipt order, and one OP_RETURN listing the N receipt ids in the same order, so output i pays
// for receipt i. Far fewer transactions, signatures and fees for the same per-hop proof.
// --payout=per-payment (default) gives every payment a fresh payout address; per-node reuses
// one address per satellite (the scheme of runs before this option, recorded in their state).
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { createHash, createHmac } from "node:crypto";
import os from "node:os";
import { PrivateKey, Transaction, P2PKH, Script, MerklePath, SatoshisPerKilobyte } from "@bsv/sdk";
import { payoutDeriver, PAYOUT_SCHEMES } from "./payout.mjs";
import { makeConstellation, simulate, verifyAll, MOC } from "./sim.mjs";
import { parseTles, makeOrbitalConstellation } from "./orbits.mjs";
import { batchProof } from "../agent/lib/batch.mjs";
import { verifyPath, pinnedDirectory, assemblePath } from "../agent/lib/path.mjs";
import { leafHash, buildTree } from "../agent/lib/merkle.mjs";
import { arcVerdict } from "../agent/lib/arc.mjs";

const arg = (k, d) => process.argv.find((a) => a.startsWith(`--${k}=`))?.split("=")[1] ?? d;
const NET = arg("network", "teratestnet");
if (!["teratestnet", "mainnet"].includes(NET)) { console.error("--network must be teratestnet or mainnet"); process.exit(2); }
const MAIN = NET === "mainnet";
const ARCADE = process.env.ARCADE_URL || (MAIN ? "https://arc.gorillapool.io" : "https://arcade-ttn-us-1.bsvblockchain.tech");
const TXPATH = MAIN ? "/v1/tx" : "/tx"; // ARC and Arcade differ only in this prefix
const ASSET = process.env.ASSET_URL || (MAIN ? "https://api.whatsonchain.com/v1/bsv/main" : "https://ttn.cls9.com/api/v1");
const STATE = new URL(MAIN ? "./.main-state.json" : "./.ttn-state.json", import.meta.url);
const kindOf = (url) => (/whatsonchain/i.test(url) ? "woc" : /arcade/i.test(url) ? "arcade" : "arc");
const BROADCASTERS = (arg("broadcast", "") || (MAIN
  ? `${ARCADE},https://arcade-us-1.bsvblockchain.tech,https://api.whatsonchain.com/v1/bsv/main`
  : ARCADE)).split(",").map((u) => u.trim().replace(/\/$/, "")).filter(Boolean).map((url) => ({ url, kind: kindOf(url), accepted: 0, failed: 0 }));
const has = (k) => process.argv.includes(`--${k}`);
const fmt = (n) => Math.round(n).toLocaleString("en-US");
const DRY = has("dry-run");
const PAY = Number(arg("pay", 100)); // satoshis paid to each relaying satellite
const CONC = Number(arg("concurrency", 8));
const BATCH = Math.max(1, Number(arg("batch", 1)));
const PAYOUT = arg("payout", "per-payment");
if (!PAYOUT_SCHEMES.includes(PAYOUT)) { console.error("--payout must be per-payment or per-node"); process.exit(2); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function pool(items, n, fn) {
  let i = 0; const out = new Array(items.length);
  await Promise.all(Array.from({ length: n }, async () => { while (i < items.length) { const k = i++; out[k] = await fn(items[k], k); } }));
  return out;
}
async function getJson(url) {
  // A slow or failing lookup is reported as status 0, not thrown: one timeout among thousands of
  // status checks must not end a confirmation pass.
  let r, body;
  for (let attempt = 0; attempt < 3; attempt++) {
    try { r = await fetch(url, { signal: AbortSignal.timeout(30000) }); body = await r.text(); break; }
    catch { r = null; await sleep(1000 * (attempt + 1)); }
  }
  if (!r) return { status: 0, j: {} };
  let j; try { j = JSON.parse(body); } catch { j = { raw: body.slice(0, 200) }; }
  return { status: r.status, j };
}

// ---- Safety: the network named, and a deliberate flag before spending real coins ---------------
let feeRate = MAIN ? 100 : 1; // sat/kB; mainnet replaced below by the broadcaster's live policy
if (!DRY && MAIN) {
  if (!has("confirm") && !has("spend-real-bsv")) { console.error("refusing to send on MAINNET without --spend-real-bsv"); process.exit(2); }
  const pol = await getJson(`${ARCADE}/v1/policy`);
  const mf = pol.j?.policy?.miningFee;
  if (pol.status !== 200 || !mf) { console.error(`refusing to run: no fee policy from ${ARCADE}`); process.exit(2); }
  feeRate = Math.max(1, (mf.satoshis / mf.bytes) * 1000);
} else if (!DRY) {
  const h = await getJson(`${ARCADE}/health`);
  const hubs = (h.j.datahub_urls || []).map((d) => d.url).join(" ");
  if (h.status !== 200 || !/ttn|teratestnet/i.test(hubs + ARCADE)) { console.error(`refusing to run: ${ARCADE} does not look like a teratestnet Arcade`); process.exit(2); }
}
const wifFile = new URL(MAIN ? "./main-funding.wif" : "./ttn-funding.wif", import.meta.url);
const funder = DRY && !existsSync(wifFile) ? PrivateKey.fromRandom() : PrivateKey.fromWif(readFileSync(wifFile, "utf8").trim());
const funderHash = funder.toPublicKey().toHash();
const funderAddr = funder.toPublicKey().toAddress(MAIN ? [0x00] : [0x6f]);
const ourScript = new P2PKH().lock(funderHash).toHex();

// The payout key of each satellite, station and operations node (separate from its Ed25519
// custody key), derived under a secret from the funding key (payout.mjs).
const payoutOf = payoutDeriver(funder, PAYOUT);

// ---- The constellation (deterministic for a fixed start time and bundle count) -----------------
function fly(bundles) {
  const tleFile = new URL("./.tle-cache/starlink.tle", import.meta.url);
  const real = existsSync(tleFile);
  const c = real
    ? makeOrbitalConstellation({ tles: parseTles(readFileSync(tleFile, "utf8")), count: 4032, startTime: new Date(Date.UTC(2026, 8, 30, 6, 0)) })
    : makeConstellation({});
  const run = simulate(c, { bundles, epochs: 40, ticksPerEpoch: 10 });
  return { c, run, base: verifyAll(c, run), orbitsNote: real ? "real orbits (public Starlink elements, SGP4)" : "grid model" };
}

// ---- Submission through Arcade -----------------------------------------------------------------
// Extended format carries each input's source output, so Arcade can validate a transaction whose
// parent is still unconfirmed. Busy or rate-limited answers are retried with backoff.
let retries = 0;
async function sendTo(b, tx, maxAttempts) {
  const url = b.kind === "woc" ? `${b.url}/tx/raw` : `${b.url}${b.kind === "arc" ? "/v1/tx" : "/tx"}`;
  const body = JSON.stringify(b.kind === "woc" ? { txhex: tx.toHex() } : { rawTx: tx.toHexEF() });
  for (let attempt = 0; ; attempt++) {
    const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body, signal: AbortSignal.timeout(30000) }).catch((e) => ({ status: 0, text: async () => String(e) }));
    const text = await r.text();
    // ARC and Arcade can answer 200 for a transaction that will never be mined (an orphan or a
    // double spend), so their txStatus decides; WhatsOnChain answers a bare txid on success.
    const v = arcVerdict(r.status, text);
    if (v.ok || (b.kind === "woc" && r.status >= 200 && r.status < 300)) return { ok: true, status: r.status, text };
    if (!v.txStatus && (r.status === 0 || r.status === 429 || r.status >= 500) && attempt < maxAttempts) { retries++; await sleep(250 * 2 ** Math.min(attempt, 6)); continue; }
    return { ok: false, status: r.status, text: (v.txStatus ? `${v.txStatus}: ${v.why}` : text).slice(0, 200) };
  }
}
// The primary must accept; the others are best effort and only counted.
async function submit(tx) {
  const [primary, ...others] = BROADCASTERS;
  const r = await sendTo(primary, tx, 8);
  (r.ok ? primary.accepted++ : primary.failed++);
  if (r.ok) await Promise.all(others.map(async (b) => { const o = await sendTo(b, tx, 2); o.ok ? b.accepted++ : b.failed++; }));
  return r;
}

if (!has("confirm")) {
  // ---- 1. Receipts -----------------------------------------------------------------------------
  const bundles = Number(arg("bundles", 10000));
  const { c, run, base, orbitsNote } = fly(bundles);
  const limit = Number(arg("limit", run.batches.length));
  const batches = run.batches.slice(0, limit);
  console.log(`${fmt(c.sats.length)} satellites, ${orbitsNote}: ${fmt(run.batches.length)} batch receipts; this run pays ${fmt(batches.length)}`);

  // ---- 2. Funding and fan-out --------------------------------------------------------------------
  let fundTx, fundVout;
  if (DRY && !has("rebroadcast")) {
    fundTx = new Transaction();
    fundTx.addOutput({ lockingScript: new P2PKH().lock(funderHash), satoshis: 1e8 });
    fundVout = 0;
  } else {
    const txid = arg("fund");
    if (!/^[0-9a-f]{64}$/i.test(txid || "")) { console.error(`pass --fund=<txid> of the transaction that paid ${funderAddr}`); process.exit(2); }
    const hex = await fetch(`${ASSET}/tx/${txid}/hex`).then((r) => r.ok ? r.text() : null);
    if (!hex) { console.error(`funding transaction ${txid} not found at ${ASSET}`); process.exit(2); }
    // The asset API may return extended format (BRC-30: marker 0000000000ef after the version).
    const clean = hex.trim().replace(/^"|"$/g, "");
    fundTx = clean.slice(8, 20).toLowerCase() === "0000000000ef" ? Transaction.fromHexEF(clean) : Transaction.fromHex(clean);
    fundVout = fundTx.outputs.findIndex((o) => o.lockingScript.toHex() === ourScript);
    if (fundVout < 0) { console.error(`transaction ${txid} does not pay ${funderAddr}`); process.exit(2); }
  }
  const available = fundTx.outputs[fundVout].satoshis;
  const epochCount = new Set(batches.map((b) => b.receipt.contactId.split(":")[0])).size;
  // Fees: each payment pays its own (about 252 bytes) out of a PAY + payFee input; fan-outs and
  // anchors pay at least 5 sat/kB (teratestnet nodes enforce a minimum their policy omits).
  const payFee = Math.max(1, Math.ceil(260 * feeRate / 1000));
  const bulkRate = Math.max(5, feeRate);
  const nFan = Math.ceil(batches.length / 1000);
  const nBatchTx = Math.ceil(batches.length / BATCH);
  const needed = BATCH > 1
    ? batches.length * PAY + nBatchTx * Math.ceil((BATCH * 67 + 300) * bulkRate / 1000) + Math.ceil((nBatchTx * 34 + 300) * bulkRate / 1000) + epochCount * Math.ceil(300 * bulkRate / 1000) + 1000
    : batches.length * (PAY + payFee) + Math.ceil((batches.length * 34 + nFan * 200) * bulkRate / 1000) + epochCount * Math.ceil(300 * bulkRate / 1000) + 1000;
  console.log(`${MAIN ? "MAINNET" : "teratestnet"} via ${ARCADE}, fee ${feeRate} sat/kB${DRY && MAIN ? " (assumed for the dry run)" : ""}: funding ${fmt(available)} sat at ${funderAddr}; this run needs about ${fmt(needed)} sat`);
  if (available < needed) { console.error("not enough funds for this run; lower --limit or add funds"); process.exit(2); }

  // 1,000 payment inputs per fan-out transaction (a signature-operation limit on the regtest node;
  // kept here so the two runs are comparable). Each fan-out spends the previous one's change.
  const perFan = 1000;
  const fanTxs = [];
  for (let made = 0; BATCH === 1 && made < batches.length; made += perFan) {
    const n = Math.min(perFan, batches.length - made);
    const prev = fanTxs.at(-1);
    const tx = new Transaction();
    tx.addInput(prev
      ? { sourceTransaction: prev, sourceOutputIndex: prev.outputs.length - 1, unlockingScriptTemplate: new P2PKH().unlock(funder) }
      : { sourceTransaction: fundTx, sourceOutputIndex: fundVout, unlockingScriptTemplate: new P2PKH().unlock(funder) });
    for (let k = 0; k < n; k++) tx.addOutput({ lockingScript: new P2PKH().lock(funderHash), satoshis: PAY + payFee });
    tx.addOutput({ lockingScript: new P2PKH().lock(funderHash), change: true });
    // Arcade's /v1/policy advertises 0 sat/kB, but teratestnet nodes enforce a minimum
    // (1 sat/kB per the quickstart's network notes): a zero-fee fan-out was REJECTED
    // "insufficient-fee" on 2026-10-18. Pay 5 sat/kB.
    await tx.fee(new SatoshisPerKilobyte(bulkRate));
    await tx.sign();
    fanTxs.push(tx);
  }

  // ---- 3. Paid, anchored transactions ------------------------------------------------------------
  const tSign0 = performance.now();
  const paid = [];
  const batchTxs = [];
  let batchFan = null;
  if (BATCH > 1) {
    // One fan-out gives every batch its own input, so each batch depends on a single parent.
    // (A chain of batches, each spending the last one's change, was tried first on teratestnet:
    // sent in seconds, some nodes saw children before parents, TX_MISSING_PARENT, and the tail
    // waited for rebroadcast.) Each batch pays up to BATCH satellites (output i for receipt i)
    // and lists those receipt ids in one OP_RETURN; fees come out of its own input.
    const groups = [];
    for (let g = 0; g < batches.length; g += BATCH) groups.push(batches.slice(g, g + BATCH).map((x) => x.receipt));
    const batchCost = (n) => n * PAY + Math.ceil((n * 67 + 300) * bulkRate / 1000);
    batchFan = new Transaction();
    batchFan.addInput({ sourceTransaction: fundTx, sourceOutputIndex: fundVout, unlockingScriptTemplate: new P2PKH().unlock(funder) });
    for (const grp of groups) batchFan.addOutput({ lockingScript: new P2PKH().lock(funderHash), satoshis: batchCost(grp.length) });
    batchFan.addOutput({ lockingScript: new P2PKH().lock(funderHash), change: true });
    await batchFan.fee(new SatoshisPerKilobyte(bulkRate));
    await batchFan.sign();
    for (const [gi, grp] of groups.entries()) {
      const tx = new Transaction();
      tx.addInput({ sourceTransaction: batchFan, sourceOutputIndex: gi, unlockingScriptTemplate: new P2PKH().unlock(funder) });
      for (const b of grp) tx.addOutput({ lockingScript: new P2PKH().lock(payoutOf(b.thisHop, b.claimId).toPublicKey().toHash()), satoshis: PAY });
      tx.addOutput({ lockingScript: Script.fromASM(`OP_FALSE OP_RETURN ${Buffer.from("custody-pay/1").toString("hex")} ${grp.map((b) => b.claimId.slice(2)).join(" ")}`), satoshis: 0 });
      tx.addOutput({ lockingScript: new P2PKH().lock(funderHash), change: true });
      await tx.fee(new SatoshisPerKilobyte(bulkRate));
      await tx.sign();
      const txid = tx.id("hex"), bytes = tx.toBinary().length;
      grp.forEach((b, i) => paid.push({ tx, claimId: b.claimId, thisHop: b.thisHop, txid, vout: i, bytes: bytes / grp.length }));
      batchTxs.push(tx);
    }
  }
  for (let i = 0; BATCH === 1 && i < batches.length; i++) {
    const b = batches[i].receipt;
    const tx = new Transaction();
    tx.addInput({ sourceTransaction: fanTxs[Math.floor(i / perFan)], sourceOutputIndex: i % perFan, unlockingScriptTemplate: new P2PKH().unlock(funder) });
    tx.addOutput({ lockingScript: new P2PKH().lock(payoutOf(b.thisHop, b.claimId).toPublicKey().toHash()), satoshis: PAY });
    tx.addOutput({ lockingScript: Script.fromASM(`OP_FALSE OP_RETURN ${Buffer.from("custody-batch/1").toString("hex")} ${b.claimId.slice(2)}`), satoshis: 0 });
    await tx.sign(); // input PAY + payFee, output PAY: payFee is the fee
    paid.push({ tx, claimId: b.claimId, thisHop: b.thisHop, txid: tx.id("hex"), vout: 0, bytes: tx.toBinary().length });
  }
  const tSign = (performance.now() - tSign0) / 1000;

  // ---- 4. Per-minute anchors, chained from the last fan-out's change ------------------------------
  const byEpoch = new Map();
  for (const b of batches) { const e = b.receipt.contactId.split(":")[0]; (byEpoch.get(e) || byEpoch.set(e, []).get(e)).push(b.receipt.claimId.slice(2)); }
  const epochRoots = [...byEpoch.entries()].map(([e, ids]) => ({ epoch: e, count: ids.length, root: buildTree(ids.sort().map((h) => leafHash(Buffer.from(h, "hex")))).root }));
  const lastPay = BATCH > 1 ? batchFan : fanTxs.at(-1);
  let prev = lastPay, prevOut = lastPay.outputs.length - 1;
  const anchors = [];
  for (const r of epochRoots) {
    const tx = new Transaction();
    tx.addInput({ sourceTransaction: prev, sourceOutputIndex: prevOut, unlockingScriptTemplate: new P2PKH().unlock(funder) });
    tx.addOutput({ lockingScript: Script.fromASM(`OP_FALSE OP_RETURN ${Buffer.from("custody-epoch/1").toString("hex")} ${r.root}`), satoshis: 0 });
    tx.addOutput({ lockingScript: new P2PKH().lock(funderHash), change: true });
    await tx.fee(new SatoshisPerKilobyte(bulkRate)); await tx.sign();
    anchors.push({ ...r, tx, txid: tx.id("hex"), bytes: tx.toBinary().length });
    prev = tx; prevOut = 1;
  }
  const avgBytes = paid.reduce((a, p) => a + p.bytes, 0) / paid.length;
  console.log(BATCH > 1
    ? `built and signed 1 fan-out, ${fmt(batchTxs.length)} batch transactions paying ${fmt(paid.length)} receipts (${BATCH} per transaction, ${avgBytes.toFixed(0)} bytes per payment, ${fmt(paid.length / tSign)} payments/s) and ${anchors.length} anchor transactions`
    : `built and signed ${fanTxs.length} fan-out, ${fmt(paid.length)} payment (avg ${avgBytes.toFixed(0)} bytes, ${fmt(paid.length / tSign)}/s) and ${anchors.length} anchor transactions`);
  if (has("rebroadcast")) {
    const st0 = JSON.parse(readFileSync(STATE, "utf8"));
    const built = new Map([...(batchFan ? [batchFan] : fanTxs), ...(BATCH > 1 ? batchTxs : paid.map((p) => p.tx)), ...anchors.map((a) => a.tx)].map((t) => [t.id("hex"), t]));
    const want = [...new Set([...(st0.fanTxids || []), ...(st0.batchTxids || []), ...st0.paid.map((p) => p.txid), ...st0.anchors.map((a) => a.txid)])];
    const missing = want.filter((id) => !built.has(id));
    if (missing.length) { console.error(`rebuild does not match the state file: ${missing.length} of ${want.length} txids differ (use the run's original --fund, --limit, --pay, --batch and --payout); nothing sent`); process.exit(2); }
    console.log(`rebuilt all ${fmt(want.length)} transactions of the run; txids match the state file`);
    const [primary] = BROADCASTERS;
    const pending = [];
    await pool(want, CONC, async (id) => {
      const { status, j } = await getJson(`${primary.url}${primary.kind === "arc" ? "/v1/tx" : "/tx"}/${id}`);
      if (!(status === 200 && /MINED|CONFIRMED/i.test(j.txStatus || ""))) pending.push(id);
    });
    const order = new Map(want.map((id, i) => [id, i]));
    pending.sort((a, b) => order.get(a) - order.get(b)); // parents before children
    console.log(`${fmt(pending.length)} not yet mined; resending to ${BROADCASTERS.map((b) => b.url).join(", ")}`);
    if (DRY) { console.log("dry run: nothing sent"); process.exit(0); }
    for (const id of pending) {
      const tx = built.get(id);
      await Promise.all(BROADCASTERS.map(async (b) => { const o = await sendTo(b, tx, 2); o.ok ? b.accepted++ : b.failed++; }));
    }
    for (const b of BROADCASTERS) console.log(`  ${b.url}: ${fmt(b.accepted)} accepted, ${fmt(b.failed)} not`);
    process.exit(0);
  }
  if (DRY) {
    // Output vout pays PAY to this payment's own payout address, and the transaction's OP_RETURN
    // carries the receipt id (for a batch, at position vout of its id list).
    const check = paid.slice(0, 3).concat(paid.slice(-2)).every((p) => {
      const ret = p.tx.outputs.find((o) => o.satoshis === 0 && o.lockingScript.toHex().startsWith("006a"));
      const ids = ret.lockingScript.toASM().split(" ").slice(3);
      const payTo = new P2PKH().lock(payoutOf(p.thisHop, p.claimId).toPublicKey().toHash()).toHex();
      return p.tx.outputs[p.vout].satoshis === PAY && p.tx.outputs[p.vout].lockingScript.toHex() === payTo
        && (BATCH > 1 ? ids[p.vout] === p.claimId.slice(2) : ids.includes(p.claimId.slice(2)));
    });
    const ef = [fanTxs[0] || batchFan, paid[0].tx, anchors[0].tx].every((t) => /^010000000000000000ef/.test(t.toHexEF()));
    console.log(`extended-format encoding for Arcade: ${ef ? "ok" : "WRONG"}`);
    console.log(`dry run: nothing sent. payment outputs and receipt commitments ${check ? "check out" : "WRONG"}`);
    process.exit(check ? 0 : 1);
  }

  // ---- Submit: fan-outs in order, then payments, then anchors -------------------------------------
  const tSend0 = performance.now();
  const rejected = [];
  for (const tx of fanTxs) { const r = await submit(tx); if (!r.ok) { console.error(`fan-out rejected (${r.status}): ${r.text}`); process.exit(1); } }
  if (BATCH > 1) {
    const rf = await submit(batchFan);
    if (!rf.ok) { console.error(`batch fan-out rejected (${rf.status}): ${rf.text}`); process.exit(1); }
    await sleep(Number(arg("settle", 3)) * 1000); // let the one parent propagate before its children
    await pool(batchTxs, CONC, async (tx) => {
      const r = await submit(tx);
      if (!r.ok) { const id = tx.id("hex"); for (const p of paid.filter((x) => x.txid === id)) rejected.push({ txid: id, status: r.status, err: r.text }); }
    });
  } else {
    await pool(paid, CONC, async (p) => { const r = await submit(p.tx); if (!r.ok) rejected.push({ txid: p.txid, status: r.status, err: r.text }); });
  }
  for (const a of anchors) { const r = await submit(a.tx); if (!r.ok) rejected.push({ txid: a.txid, status: r.status, err: r.text, anchor: true }); }
  const tSend = (performance.now() - tSend0) / 1000;
  const state = {
    startedAt: new Date().toISOString(), arcade: ARCADE, asset: ASSET, bundles, limit: batches.length, pay: PAY, concurrency: CONC, network: NET, feeRate,
    satellites: c.sats.length, orbitsNote, delivered: run.delivered.length, verifiedOffChain: base.verified, failedOffChain: base.failed,
    batch: BATCH, payout: PAYOUT, fanTxids: (batchFan ? [batchFan] : fanTxs).map((t) => t.id("hex")), batchTxids: batchTxs.map((t) => t.id("hex")),
    paid: paid.map(({ claimId, thisHop, txid, vout, bytes }) => ({ claimId, thisHop, txid, vout, bytes })),
    anchors: anchors.map(({ epoch, count, root, txid, bytes }) => ({ epoch, count, root, txid, bytes })),
    rejected, retries, tSign, tSend, avgBytes,
    broadcasters: BROADCASTERS.map(({ url, accepted, failed }) => ({ url, accepted, failed })),
  };
  writeFileSync(STATE, JSON.stringify(state));
  const txCount = (BATCH > 1 ? batchTxs.length + 1 : paid.length + fanTxs.length) + anchors.length;
  console.log(`submitted ${fmt(txCount)} transactions in ${tSend.toFixed(1)} s: ${fmt(paid.length + anchors.length - rejected.length)} payments and anchors accepted (${fmt((paid.length - rejected.length) / tSend)} payments per second), ${rejected.length} rejected, ${retries} busy retries`);
  if (rejected.length) console.log("first rejections:", rejected.slice(0, 3));
  for (const b of BROADCASTERS) console.log(`  ${b.url}: ${fmt(b.accepted)} accepted, ${fmt(b.failed)} not`);
  console.log("state saved; run again with --confirm once blocks have been mined");
  process.exit(rejected.length ? 1 : 0);
}

// ---- 5. Confirm and prove ------------------------------------------------------------------------
const st = JSON.parse(readFileSync(STATE, "utf8"));
const headerRoot = new Map();
// SPV: do not take a header service's word for it. Rebuild each header from its fields, check it
// hashes to the block hash Arcade/ARC named, and that the hash meets the header's own difficulty
// target (proof of work). Only then is its merkle root used to check a merkle path.
let headersPowChecked = 0, headersPowFailed = 0;
const sha256d = (b) => createHash("sha256").update(createHash("sha256").update(b).digest()).digest();
function headerProofOfWork(j, blockHash) {
  const u32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32LE(Number(n) >>> 0); return b; };
  const rev = (h) => Buffer.from(String(h), "hex").reverse();
  const bits = typeof j.bits === "string" ? parseInt(j.bits, 16) : Number(j.bits);
  const prev = j.previousblockhash || j.hash_prev_block || j.prevhash;
  const root = j.merkleroot || j.hashMerkleRoot || j.merkle_root;
  if (!prev || !root || !Number.isFinite(bits)) return false;
  const raw = Buffer.concat([u32(j.version), rev(prev), rev(root), u32(j.time ?? j.timestamp), u32(bits), u32(j.nonce)]);
  const hash = Buffer.from(sha256d(raw)).reverse().toString("hex");
  const target = BigInt(bits & 0x007fffff) * (1n << BigInt(8 * ((bits >>> 24) - 3)));
  return hash === String(blockHash).toLowerCase() && BigInt("0x" + hash) <= target;
}
// Headers by block hash (the asset API's header-by-height route now requires authentication,
// seen 2026-10-18); the header must also report the height Arcade gave.
// One lookup per header: the promise is cached, so concurrent proofs in the same block share it.
function merkleRootAt(height, blockHash) {
  const key = blockHash || height;
  if (!headerRoot.has(key)) {
    headerRoot.set(key, (async () => {
      const url = MAIN ? `${ASSET}/block/${blockHash}/header`
        : blockHash ? `${ASSET}/header/${blockHash}/json` : `${ASSET}/header/height/${height}/json`;
      const { status, j } = await getJson(url);
      const okHeight = status === 200 && (j.height == null || Number(j.height) === Number(height));
      let rootOut = okHeight ? (j.merkleroot || j.hashMerkleRoot || j.merkle_root || null) : null;
      if (rootOut && blockHash) {
        if (headerProofOfWork(j, blockHash)) headersPowChecked++;
        else { headersPowFailed++; rootOut = "header-failed-proof-of-work"; }
      }
      return rootOut;
    })());
  }
  return headerRoot.get(key);
}
async function statusOf(txid) {
  const { status, j } = await getJson(`${ARCADE}${TXPATH}/${txid}`);
  if (status !== 200) return { txid, state: "UNKNOWN", http: status };
  const state = j.txStatus || j.status || j.state || "UNKNOWN";
  const height = j.blockHeight ?? j.block_height ?? null;
  const bump = j.merklePath || j.merkle_path || j.bump || null;
  const blockHash = j.blockHash || j.block_hash || null;
  let proofOk = null;
  if (bump && height != null) {
    try {
      const root = MerklePath.fromHex(bump).computeRoot(txid);
      const hdr = await merkleRootAt(height, blockHash);
      proofOk = hdr ? root === hdr : null;
    } catch { proofOk = false; }
  }
  return { txid, state, height, proofOk };
}
// A batch transaction carries many payments: ask about each transaction once.
const all = [...new Set([...st.paid.map((p) => p.txid), ...st.anchors.map((a) => a.txid)])];
const statuses = await pool(all, Number(arg("concurrency", 4)), statusOf);
const byTxid = new Map(statuses.map((s) => [s.txid, s]));
const mined = (txid) => { const s = byTxid.get(txid); return s && s.height != null && /MINED|CONFIRMED/i.test(s.state) && s.proofOk !== false; };
const paidConfirmed = st.paid.filter((p) => mined(p.txid)).length;
const anchorsConfirmed = st.anchors.filter((a) => mined(a.txid)).length;
const proofsChecked = statuses.filter((s) => s.proofOk === true).length;
const states = {}; for (const s of statuses) states[s.state] = (states[s.state] || 0) + 1;

// Chain proof for sampled bundles: each hop's receipt verifies (custody) and its paying transaction
// is mined with a merkle proof that matches the block header (payment bound to custody).
const { c, run } = fly(st.bundles);
const txOf = new Map(st.paid.map((p) => [p.claimId, p.txid]));
const dir = pinnedDirectory(new Map([...c.keys].map(([eid, kp]) => [eid, kp.pub])));
const byBundle = new Map();
for (const b of run.batches) for (const id of b.leaves) (byBundle.get(id) || byBundle.set(id, []).get(id)).push(b);
const covered = run.delivered.filter((d) => byBundle.get(d.bundleId).every((b) => txOf.has(b.receipt.claimId)));
const sample = covered.filter((_, k) => k % Math.max(1, Math.floor(covered.length / 100)) === 0).slice(0, 100);
let proven = 0, hopsChecked = 0;
for (const d of sample) {
  const path = assemblePath(byBundle.get(d.bundleId).map((b) => ({ receipt: b.receipt, proof: batchProof(b, d.bundleId) })), d.source);
  const v = verifyPath(path, { bundleId: d.bundleId, source: d.source, destination: MOC, authorize: dir, maxHops: 256 });
  let ok = v.ok;
  for (const link of path) { hopsChecked++; if (!mined(txOf.get(link.receipt.claimId))) ok = false; }
  if (ok) proven++;
}
const heights = statuses.map((s) => s.height).filter((h) => h != null);
const ok = st.rejected.length === 0 && paidConfirmed === st.paid.length && anchorsConfirmed === st.anchors.length && proven === sample.length && sample.length > 0;
const lines = [
  MAIN ? `# Custody receipts and per-hop payments on Bitcoin BSV mainnet: ${fmt(st.satellites)} satellites` : `# Custody receipts and per-hop payments on teratestnet: ${fmt(st.satellites)} satellites`, "",
  MAIN ? `Submitted ${st.startedAt.slice(0, 10)} from ${os.cpus()[0].model.trim()}, Node ${process.version}, through ARC (${st.arcade}) to **Bitcoin BSV mainnet** at ${st.feeRate} sat/kB. Reproduce: \`node constellation/ttn-run.mjs --network=mainnet --spend-real-bsv --fund=<txid>\`, then \`--network=mainnet --confirm\`.`
    : `Submitted ${st.startedAt.slice(0, 10)} from ${os.cpus()[0].model.trim()}, Node ${process.version}, through Arcade (${st.arcade}) to **teratestnet**, BSV's public Teranode test network. Teratestnet coins have no value. Reproduce: \`node constellation/ttn-run.mjs --fund=<txid>\`, then \`--confirm\`.`, "",
  "## What went on chain", "",
  "| | |", "|---|---|",
  `| Constellation | ${fmt(st.satellites)} satellites, ${st.orbitsNote}; ${fmt(st.delivered)} bundles delivered, ${fmt(st.verifiedOffChain)} verified off chain |`,
  `| Paid, anchored transactions (pay the relaying satellite ${st.pay} sat and commit the receipt id) | ${fmt(st.paid.length)} submitted, ${fmt(st.rejected.length)} rejected, ${fmt(paidConfirmed)} mined |`,
  `| Average transaction size | ${st.avgBytes.toFixed(0)} bytes |`,
  `| Per-minute anchors | ${st.anchors.length} transactions, ${anchorsConfirmed} mined |`,
  `| Blocks | ${heights.length ? `${Math.min(...heights)} to ${Math.max(...heights)}` : "none yet"}; ${fmt(proofsChecked)} merkle proofs checked against block headers, ${headersPowChecked} distinct headers rebuilt and their proof of work verified${headersPowFailed ? `, ${headersPowFailed} FAILED` : ""} |`,
  ...(st.batch > 1 ? [`| Batching | ${st.batch} payments per transaction (${fmt(st.batchTxids.length)} transactions), each payment to a fresh payout address |`] : []),
  `| Status counts | ${Object.entries(states).map(([k, v]) => `${k} ${fmt(v)}`).join(", ")} |`, "",
  "## Timing", "",
  "| Step | Time | Rate |", "|---|---|---|",
  `| Build and sign ${fmt(st.paid.length)} payment transactions (JavaScript, one thread) | ${st.tSign.toFixed(1)} s | ${fmt(st.paid.length / st.tSign)} per second |`,
  `| Submit to ${MAIN ? "ARC" : "Arcade"} (${st.concurrency} concurrent, ${fmt(st.retries)} busy retries) | ${st.tSend.toFixed(1)} s | **${fmt((st.paid.length - st.rejected.length) / st.tSend)} accepted per second** |`, "",
  "Submission rate here is one client on one desktop against a shared public service, with deliberately limited concurrency; it is not a measure of Teranode's or the broadcaster's capacity.", "",
  "## Proven from the chain", "",
  `For ${sample.length} sampled bundles (${fmt(hopsChecked)} hops), each hop's custody receipt verified and the transaction paying that hop and committing that receipt was mined, with a merkle proof matching the block header: **${proven} of ${sample.length} bundles fully custodied and paid**.`, "",
  "## Limits", "",
  MAIN ? "- Mainnet: real coins and fees. The satellites' payout addresses belong to keys held with the funding key, so their payments can be swept back." : "- Teratestnet is a public test network: real propagation and competing load, but no-value coins and test-network fee policy.",
  "- Payments come from one funding key to per-node payout addresses; the Operator Edition's non-custodial statements are the production settlement path.",
];
const text = lines.join("\n") + "\n";
console.log(text);
console.log(`${MAIN ? "MAIN" : "TTN"}_RESULT ${JSON.stringify({ ok, paid: st.paid.length, mined: paidConfirmed, anchors: anchorsConfirmed, merkleProofsMatchingHeaders: proofsChecked, of: statuses.length, headersProofOfWork: headersPowChecked, headersFailedPow: headersPowFailed, sampledBundles: sample.length, proven, states })}`);
if (has("write")) writeFileSync(new URL(MAIN ? "./MAIN-RESULTS.md" : "./TTN-RESULTS.md", import.meta.url), text);
process.exit(ok ? 0 : 1);
