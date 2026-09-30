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
// Teratestnet coins have no value. The script refuses anything that is not teratestnet.
// The funding key is read from constellation/ttn-funding.wif (git-ignored) and never printed.
//
//   node constellation/ttn-run.mjs --dry-run [--limit=N]          build and sign only, send nothing
//   node constellation/ttn-run.mjs --fund=<txid> --limit=50         small test batch
//   node constellation/ttn-run.mjs --fund=<txid>                    the full run
//   node constellation/ttn-run.mjs --confirm [--write]              check confirmations, write results
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import os from "node:os";
import { PrivateKey, Transaction, P2PKH, Script, MerklePath } from "@bsv/sdk";
import { makeConstellation, simulate, verifyAll, MOC } from "./sim.mjs";
import { parseTles, makeOrbitalConstellation } from "./orbits.mjs";
import { batchProof } from "../agent/lib/batch.mjs";
import { verifyPath, pinnedDirectory, assemblePath } from "../agent/lib/path.mjs";
import { leafHash, buildTree } from "../agent/lib/merkle.mjs";

const ARCADE = process.env.ARCADE_URL || "https://arcade-ttn-us-1.bsvblockchain.tech";
const ASSET = process.env.ASSET_URL || "https://ttn.cls9.com/api/v1";
const STATE = new URL("./.ttn-state.json", import.meta.url);
const arg = (k, d) => process.argv.find((a) => a.startsWith(`--${k}=`))?.split("=")[1] ?? d;
const has = (k) => process.argv.includes(`--${k}`);
const fmt = (n) => Math.round(n).toLocaleString("en-US");
const DRY = has("dry-run");
const PAY = Number(arg("pay", 100)); // satoshis paid to each relaying satellite
const CONC = Number(arg("concurrency", 8));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function pool(items, n, fn) {
  let i = 0; const out = new Array(items.length);
  await Promise.all(Array.from({ length: n }, async () => { while (i < items.length) { const k = i++; out[k] = await fn(items[k], k); } }));
  return out;
}
async function getJson(url) {
  const r = await fetch(url, { signal: AbortSignal.timeout(20000) });
  const body = await r.text();
  let j; try { j = JSON.parse(body); } catch { j = { raw: body.slice(0, 200) }; }
  return { status: r.status, j };
}

// ---- Safety: teratestnet only ------------------------------------------------------------------
if (!DRY) {
  const h = await getJson(`${ARCADE}/health`);
  const hubs = (h.j.datahub_urls || []).map((d) => d.url).join(" ");
  if (h.status !== 200 || !/ttn|teratestnet/i.test(hubs + ARCADE)) { console.error(`refusing to run: ${ARCADE} does not look like a teratestnet Arcade`); process.exit(2); }
}
const wifFile = new URL("./ttn-funding.wif", import.meta.url);
const funder = DRY && !existsSync(wifFile) ? PrivateKey.fromRandom() : PrivateKey.fromWif(readFileSync(wifFile, "utf8").trim());
const funderHash = funder.toPublicKey().toHash();
const funderAddr = funder.toPublicKey().toAddress([0x6f]);
const ourScript = new P2PKH().lock(funderHash).toHex();

// The payout key of each satellite, station and operations node (separate from its Ed25519 custody key).
const payoutKey = new Map();
const payoutOf = (eid) => { if (!payoutKey.has(eid)) payoutKey.set(eid, PrivateKey.fromHex(createHash("sha256").update(`payout:${eid}`).digest("hex"))); return payoutKey.get(eid); };

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
async function submit(tx) {
  const body = JSON.stringify({ rawTx: tx.toHexEF() });
  for (let attempt = 0; ; attempt++) {
    const r = await fetch(`${ARCADE}/tx`, { method: "POST", headers: { "content-type": "application/json" }, body, signal: AbortSignal.timeout(30000) }).catch((e) => ({ status: 0, text: async () => String(e) }));
    const text = await r.text();
    if (r.status >= 200 && r.status < 300) return { ok: true, status: r.status, text };
    if (/already|known|exists/i.test(text)) return { ok: true, status: r.status, text };
    if ((r.status === 0 || r.status === 429 || r.status >= 500) && attempt < 8) { retries++; await sleep(250 * 2 ** Math.min(attempt, 6)); continue; }
    return { ok: false, status: r.status, text: text.slice(0, 200) };
  }
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
  if (DRY) {
    fundTx = new Transaction();
    fundTx.addOutput({ lockingScript: new P2PKH().lock(funderHash), satoshis: 1e8 });
    fundVout = 0;
  } else {
    const txid = arg("fund");
    if (!/^[0-9a-f]{64}$/i.test(txid || "")) { console.error(`pass --fund=<txid> of the transaction that paid ${funderAddr}`); process.exit(2); }
    const hex = await fetch(`${ASSET}/tx/${txid}/hex`).then((r) => r.ok ? r.text() : null);
    if (!hex) { console.error(`funding transaction ${txid} not found at ${ASSET}`); process.exit(2); }
    fundTx = Transaction.fromHex(hex.trim().replace(/^"|"$/g, ""));
    fundVout = fundTx.outputs.findIndex((o) => o.lockingScript.toHex() === ourScript);
    if (fundVout < 0) { console.error(`transaction ${txid} does not pay ${funderAddr}`); process.exit(2); }
  }
  const available = fundTx.outputs[fundVout].satoshis;
  const epochCount = new Set(batches.map((b) => b.receipt.contactId.split(":")[0])).size;
  const needed = batches.length * (PAY + 1) + epochCount * 10 + 1000;
  console.log(`funding ${fmt(available)} sat at ${funderAddr}; this run needs about ${fmt(needed)} sat`);
  if (available < needed) { console.error("not enough funds for this run; lower --limit or add funds"); process.exit(2); }

  // 1,000 payment inputs per fan-out transaction (a signature-operation limit on the regtest node;
  // kept here so the two runs are comparable). Each fan-out spends the previous one's change.
  const perFan = 1000;
  const fanTxs = [];
  for (let made = 0; made < batches.length; made += perFan) {
    const n = Math.min(perFan, batches.length - made);
    const prev = fanTxs.at(-1);
    const tx = new Transaction();
    tx.addInput(prev
      ? { sourceTransaction: prev, sourceOutputIndex: prev.outputs.length - 1, unlockingScriptTemplate: new P2PKH().unlock(funder) }
      : { sourceTransaction: fundTx, sourceOutputIndex: fundVout, unlockingScriptTemplate: new P2PKH().unlock(funder) });
    for (let k = 0; k < n; k++) tx.addOutput({ lockingScript: new P2PKH().lock(funderHash), satoshis: PAY + 1 });
    tx.addOutput({ lockingScript: new P2PKH().lock(funderHash), change: true });
    await tx.fee(0); // teratestnet policy: 0 sat/kB (checked at /v1/policy)
    await tx.sign();
    fanTxs.push(tx);
  }

  // ---- 3. Paid, anchored transactions ------------------------------------------------------------
  const tSign0 = performance.now();
  const paid = [];
  for (let i = 0; i < batches.length; i++) {
    const b = batches[i].receipt;
    const tx = new Transaction();
    tx.addInput({ sourceTransaction: fanTxs[Math.floor(i / perFan)], sourceOutputIndex: i % perFan, unlockingScriptTemplate: new P2PKH().unlock(funder) });
    tx.addOutput({ lockingScript: new P2PKH().lock(payoutOf(b.thisHop).toPublicKey().toHash()), satoshis: PAY });
    tx.addOutput({ lockingScript: Script.fromASM(`OP_FALSE OP_RETURN ${Buffer.from("custody-batch/1").toString("hex")} ${b.claimId.slice(2)}`), satoshis: 0 });
    await tx.sign(); // input PAY+1, output PAY: 1 sat fee
    paid.push({ tx, claimId: b.claimId, thisHop: b.thisHop, txid: tx.id("hex"), bytes: tx.toBinary().length });
  }
  const tSign = (performance.now() - tSign0) / 1000;

  // ---- 4. Per-minute anchors, chained from the last fan-out's change ------------------------------
  const byEpoch = new Map();
  for (const b of batches) { const e = b.receipt.contactId.split(":")[0]; (byEpoch.get(e) || byEpoch.set(e, []).get(e)).push(b.receipt.claimId.slice(2)); }
  const epochRoots = [...byEpoch.entries()].map(([e, ids]) => ({ epoch: e, count: ids.length, root: buildTree(ids.sort().map((h) => leafHash(Buffer.from(h, "hex")))).root }));
  let prev = fanTxs.at(-1), prevOut = fanTxs.at(-1).outputs.length - 1;
  const anchors = [];
  for (const r of epochRoots) {
    const tx = new Transaction();
    tx.addInput({ sourceTransaction: prev, sourceOutputIndex: prevOut, unlockingScriptTemplate: new P2PKH().unlock(funder) });
    tx.addOutput({ lockingScript: Script.fromASM(`OP_FALSE OP_RETURN ${Buffer.from("custody-epoch/1").toString("hex")} ${r.root}`), satoshis: 0 });
    tx.addOutput({ lockingScript: new P2PKH().lock(funderHash), change: true });
    await tx.fee(1); await tx.sign();
    anchors.push({ ...r, tx, txid: tx.id("hex"), bytes: tx.toBinary().length });
    prev = tx; prevOut = 1;
  }
  const avgBytes = paid.reduce((a, p) => a + p.bytes, 0) / paid.length;
  console.log(`built and signed ${fanTxs.length} fan-out, ${fmt(paid.length)} payment (avg ${avgBytes.toFixed(0)} bytes, ${fmt(paid.length / tSign)}/s) and ${anchors.length} anchor transactions`);
  if (DRY) {
    const check = paid.slice(0, 3).every((p) => p.tx.outputs[0].satoshis === PAY && p.tx.outputs[1].lockingScript.toHex().includes(p.claimId.slice(2)));
    const ef = [fanTxs[0], paid[0].tx, anchors[0].tx].every((t) => /^010000000000000000ef/.test(t.toHexEF()));
    console.log(`extended-format encoding for Arcade: ${ef ? "ok" : "WRONG"}`);
    console.log(`dry run: nothing sent. payment outputs and receipt commitments ${check ? "check out" : "WRONG"}`);
    process.exit(check ? 0 : 1);
  }

  // ---- Submit: fan-outs in order, then payments, then anchors -------------------------------------
  const tSend0 = performance.now();
  const rejected = [];
  for (const tx of fanTxs) { const r = await submit(tx); if (!r.ok) { console.error(`fan-out rejected (${r.status}): ${r.text}`); process.exit(1); } }
  await pool(paid, CONC, async (p) => { const r = await submit(p.tx); if (!r.ok) rejected.push({ txid: p.txid, status: r.status, err: r.text }); });
  for (const a of anchors) { const r = await submit(a.tx); if (!r.ok) rejected.push({ txid: a.txid, status: r.status, err: r.text, anchor: true }); }
  const tSend = (performance.now() - tSend0) / 1000;
  const state = {
    startedAt: new Date().toISOString(), arcade: ARCADE, asset: ASSET, bundles, limit: batches.length, pay: PAY, concurrency: CONC,
    satellites: c.sats.length, orbitsNote, delivered: run.delivered.length, verifiedOffChain: base.verified, failedOffChain: base.failed,
    fanTxids: fanTxs.map((t) => t.id("hex")),
    paid: paid.map(({ claimId, thisHop, txid, bytes }) => ({ claimId, thisHop, txid, bytes })),
    anchors: anchors.map(({ epoch, count, root, txid, bytes }) => ({ epoch, count, root, txid, bytes })),
    rejected, retries, tSign, tSend, avgBytes,
  };
  writeFileSync(STATE, JSON.stringify(state));
  console.log(`submitted in ${tSend.toFixed(1)} s: ${fmt(paid.length + anchors.length - rejected.length)} accepted (${fmt((paid.length - rejected.length) / tSend)} payments per second), ${rejected.length} rejected, ${retries} busy retries`);
  if (rejected.length) console.log("first rejections:", rejected.slice(0, 3));
  console.log("state saved; run again with --confirm once blocks have been mined");
  process.exit(rejected.length ? 1 : 0);
}

// ---- 5. Confirm and prove ------------------------------------------------------------------------
const st = JSON.parse(readFileSync(STATE, "utf8"));
const headerRoot = new Map();
async function merkleRootAt(height) {
  if (!headerRoot.has(height)) {
    const { status, j } = await getJson(`${ASSET}/header/height/${height}/json`);
    headerRoot.set(height, status === 200 ? (j.merkleroot || j.hashMerkleRoot || j.merkle_root || null) : null);
  }
  return headerRoot.get(height);
}
async function statusOf(txid) {
  const { status, j } = await getJson(`${ARCADE}/tx/${txid}`);
  if (status !== 200) return { txid, state: "UNKNOWN", http: status };
  const state = j.txStatus || j.status || j.state || "UNKNOWN";
  const height = j.blockHeight ?? j.block_height ?? null;
  const bump = j.merklePath || j.merkle_path || j.bump || null;
  let proofOk = null;
  if (bump && height != null) {
    try {
      const root = MerklePath.fromHex(bump).computeRoot(txid);
      const hdr = await merkleRootAt(height);
      proofOk = hdr ? root === hdr : null;
    } catch { proofOk = false; }
  }
  return { txid, state, height, proofOk };
}
const all = [...st.paid.map((p) => p.txid), ...st.anchors.map((a) => a.txid)];
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
  `# Custody receipts and per-hop payments on teratestnet: ${fmt(st.satellites)} satellites`, "",
  `Submitted ${st.startedAt.slice(0, 10)} from ${os.cpus()[0].model.trim()}, Node ${process.version}, through Arcade (${st.arcade}) to **teratestnet**, BSV's public Teranode test network. Teratestnet coins have no value. Reproduce: \`node constellation/ttn-run.mjs --fund=<txid>\`, then \`--confirm\`.`, "",
  "## What went on chain", "",
  "| | |", "|---|---|",
  `| Constellation | ${fmt(st.satellites)} satellites, ${st.orbitsNote}; ${fmt(st.delivered)} bundles delivered, ${fmt(st.verifiedOffChain)} verified off chain |`,
  `| Paid, anchored transactions (pay the relaying satellite ${st.pay} sat and commit the receipt id) | ${fmt(st.paid.length)} submitted, ${fmt(st.rejected.length)} rejected, ${fmt(paidConfirmed)} mined |`,
  `| Average transaction size | ${st.avgBytes.toFixed(0)} bytes |`,
  `| Per-minute anchors | ${st.anchors.length} transactions, ${anchorsConfirmed} mined |`,
  `| Blocks | ${heights.length ? `${Math.min(...heights)} to ${Math.max(...heights)}` : "none yet"}; ${fmt(proofsChecked)} merkle proofs from Arcade checked against block headers |`,
  `| Status counts | ${Object.entries(states).map(([k, v]) => `${k} ${fmt(v)}`).join(", ")} |`, "",
  "## Timing", "",
  "| Step | Time | Rate |", "|---|---|---|",
  `| Build and sign ${fmt(st.paid.length)} payment transactions (JavaScript, one thread) | ${st.tSign.toFixed(1)} s | ${fmt(st.paid.length / st.tSign)} per second |`,
  `| Submit to Arcade (${st.concurrency} concurrent, ${fmt(st.retries)} busy retries) | ${st.tSend.toFixed(1)} s | **${fmt((st.paid.length - st.rejected.length) / st.tSend)} accepted per second** |`, "",
  "Submission rate here is one client on one desktop against a shared public service, with deliberately limited concurrency; it is not a measure of Teranode's or Arcade's capacity.", "",
  "## Proven from the chain", "",
  `For ${sample.length} sampled bundles (${fmt(hopsChecked)} hops), each hop's custody receipt verified and the transaction paying that hop and committing that receipt was mined, with a merkle proof matching the block header: **${proven} of ${sample.length} bundles fully custodied and paid**.`, "",
  "## Limits", "",
  "- Teratestnet is a public test network: real propagation and competing load, but no-value coins and test-network fee policy.",
  "- Payments come from one funding key to per-node payout addresses; the Operator Edition's non-custodial statements are the production settlement path.",
];
const text = lines.join("\n") + "\n";
console.log(text);
console.log(`TTN_RESULT ${JSON.stringify({ ok, paid: st.paid.length, mined: paidConfirmed, anchors: anchorsConfirmed, proven, states })}`);
if (has("write")) writeFileSync(new URL("./TTN-RESULTS.md", import.meta.url), text);
process.exit(ok ? 0 : 1);
