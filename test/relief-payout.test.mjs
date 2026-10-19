// Relay payouts (relief/kit/payout.mjs), offline: what is owed comes from the hub's frame
// log, the transaction pays each relay's payTo once and commits to the paid handoffs, and a
// handoff recorded as paid is never owed again. Uses a synthetic funding transaction; nothing
// is broadcast.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PrivateKey, Transaction, P2PKH } from "@bsv/sdk";
import { provision } from "../relief/kit/provision.mjs";
import { startNode } from "../relief/kit/node.mjs";
import { memoryNetwork } from "../relief/kit/lib/transport.mjs";
import { owed, buildPayout, commitment } from "../relief/kit/payout.mjs";

const deployment = JSON.parse(readFileSync(new URL("../relief/kit/deployment.example.json", import.meta.url), "utf8"));
const report = readFileSync(new URL("../relief/kit/samples/clinic-north-report.json", import.meta.url));

async function deliver() {
  const payTo = { "courier-07": PrivateKey.fromRandom().toAddress(), "village-kalo": PrivateKey.fromRandom().toAddress() };
  const d = { ...deployment, chunkSize: 128, nodes: deployment.nodes.map((n) => (payTo[n.name] ? { ...n, payTo: payTo[n.name] } : n)) };
  const { configs } = provision(d);
  delete configs["district-hub"].dashboard;
  const net = memoryNetwork(), root = mkdtempSync(join(tmpdir(), "relief-pay-")), nodes = {};
  for (const name of ["district-hub", "village-kalo", "courier-07", "clinic-north"]) nodes[name] = await startNode(configs[name], { dataDir: join(root, name), transport: net.transport(configs[name].eid), pollMs: 3600_000 });
  after(() => Object.values(nodes).forEach((n) => n.stop()));
  writeFileSync(join(root, "clinic-north", "outbox", "r.json"), report);
  await nodes["clinic-north"].poll(); await nodes["clinic-north"].poll(); await net.settle();
  return { hub: configs["district-hub"], hubDir: join(root, "district-hub"), payTo };
}

test("payout: owed is rebuilt from the frame log and paid once per handoff, with a commitment", async () => {
  const { hub, hubDir, payTo } = await deliver();
  const { rows, rate } = owed(hub, hubDir);
  assert.equal(rows.length, 2);
  const chunks = rows[0].bundleIds.length;
  assert.ok(chunks > 1);
  for (const r of rows) assert.equal(r.sats, chunks * rate);

  const funder = PrivateKey.fromRandom();
  const fundTx = new Transaction();
  fundTx.addOutput({ lockingScript: new P2PKH().lock(funder.toPublicKey().toAddress()), satoshis: 100_000 });
  const { tx, root } = await buildPayout(rows, { funder, fundTx, vout: 0, feeRate: 100 });
  const outs = tx.outputs.map((o) => ({ s: o.satoshis, script: o.lockingScript.toHex() }));
  for (const name of ["courier-07", "village-kalo"]) assert.ok(outs.some((o) => o.s === chunks * rate && o.script === new P2PKH().lock(payTo[name]).toHex()), `${name} paid`);
  assert.ok(outs.some((o) => o.s === 0 && o.script.includes(root)), "OP_RETURN commits to the paid handoffs");
  assert.equal(root, commitment(rows));

  // Record it as paid: nothing is owed afterwards.
  appendFileSync(join(hubDir, "payouts.jsonl"), JSON.stringify({ txid: tx.id("hex"), paid: rows.map(({ relay, bundleIds, sats }) => ({ relay, bundleIds, sats })) }) + "\n");
  assert.deepEqual(owed(hub, hubDir).rows, []);
});

test("payout: refuses an underfunded output and a deployment without payout addresses", async () => {
  const { hub, hubDir } = await deliver();
  const { rows } = owed(hub, hubDir);
  const funder = PrivateKey.fromRandom();
  const small = new Transaction();
  small.addOutput({ lockingScript: new P2PKH().lock(funder.toPublicKey().toAddress()), satoshis: 10 });
  await assert.rejects(buildPayout(rows, { funder, fundTx: small, vout: 0 }));
  await assert.rejects(buildPayout(rows.map((r) => ({ ...r, payTo: null })), { funder, fundTx: small, vout: 0 }), /nothing payable/);
});
