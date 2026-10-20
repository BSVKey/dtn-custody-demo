// The faucet (radio/faucet/), offline: planning refuses coins too small to claim and funding
// too small to make them; the fan-out makes the coins; bearer coin lines fit one sound or radio
// message and sweep offline; claims are paid once per sender, device and address, never the same
// coin twice, across restarts and concurrent claims; the amateur profile refuses all of it.
// Synthetic funding; nothing is broadcast.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PrivateKey } from "@bsv/sdk";
import { demoPayment, checkOffline, encodePayment, paysAddress } from "../radio/lib/payment.mjs";
import { planFaucet, buildFanout, coinKey, coinLine, parseCoinLine, sweepCoinLine, announcement, parseAnnouncement, claimText, faucetId } from "../radio/faucet/faucet.mjs";
import { faucetClaims, combineHandlers } from "../radio/faucet/claims.mjs";
import { announceLines } from "../radio/faucet/cli.mjs";
import { smsGateway } from "../radio/sms/gateway.mjs";
import { paymentTexts, readReceiptText } from "../radio/sms/text.mjs";
import { hamRefusal } from "../radio/lib/ham.mjs";

const addr = () => PrivateKey.fromRandom().toAddress();

async function faucet({ coinSats = 1000, count = 5, fund = 20_000, mode = "claims" } = {}) {
  const master = PrivateKey.fromRandom();
  const { tx: fundTx } = await demoPayment({ to: master.toAddress(), sats: fund, fund: fund + 5000 });
  const built = await buildFanout({ master, fundTx, coinSats, count, mode });
  const config = { id: built.id, funding: built.funding, mode, coinSats, count, feeRate: 100, fanoutTxid: built.tx.id("hex") };
  return { master, fundTx, built, config };
}

test("plan: coins must cover the claim fee; funding must cover coins and fee", () => {
  const p = planFaucet({ coinSats: 1000, total: 20_500 });
  assert.equal(p.count, 20);
  assert.equal(p.leftover, 500);
  assert.equal(p.received, 1000 - p.claimFee);
  assert.equal(p.need, 20_000 + p.fanoutFee);
  assert.throws(() => planFaucet({ coinSats: 20, count: 5 }), /too small/);
  assert.throws(() => planFaucet({ coinSats: 1000, total: 999 }), /does not make one coin/);
  assert.throws(() => planFaucet({ coinSats: 1000, count: 10, fundSats: 9_999 }), /need/);
  assert.throws(() => planFaucet({ coinSats: 1000, count: 5000 }), /at most/);
  assert.ok(planFaucet({ coinSats: 5, count: 1, feeRate: 1, minCoin: 2 }));
});

test("fan-out: one coin per output to its own key, a tag, change back; valid offline", async () => {
  const { master, built, fundTx } = await faucet({ count: 5 });
  const { tx, funding } = built;
  assert.equal(checkOffline(tx).ok, true);
  assert.equal(tx.outputs.length, 5 + 2);
  for (let i = 0; i < 5; i++) {
    assert.equal(tx.outputs[i].satoshis, 1000);
    assert.equal(paysAddress(tx, coinKey(master, funding, i).toAddress(), 1000).ok, true);
  }
  assert.match(Buffer.from(tx.outputs[5].lockingScript.toHex(), "hex").toString("latin1"), /bsvkey-faucet\/1/);
  await assert.rejects(buildFanout({ master: PrivateKey.fromRandom(), fundTx, coinSats: 1000, count: 5 }), /does not pay/);
  await assert.rejects(buildFanout({ master, fundTx, coinSats: 1000, count: 50 }), /need/);
  // a different funding output gives different coins and a different faucet id
  const other = await faucet();
  assert.notEqual(coinKey(master, funding, 0).toWif(), coinKey(master, other.built.funding, 0).toWif());
  assert.notEqual(faucetId(master, funding), faucetId(master, "00".repeat(32) + ":0"));
});

test("bearer: coin lines fit one message, sweep offline to any address, and the gateway relays the sweep", async () => {
  const { master, config } = await faucet({ coinSats: 500, count: 3, mode: "bearer" });
  const lines = announceLines({ config, master });
  assert.equal(lines.length, 4);
  assert.equal(parseAnnouncement(lines[0]).mode, "bearer");
  for (const l of lines) assert.ok(l.length <= 140 && /^[\x20-\x7e]+$/.test(l));
  const c = parseCoinLine(lines[2]);
  assert.equal(c.i, 1);
  assert.equal(c.sats, 500);
  const to = addr();
  const tx = await sweepCoinLine(lines[2], to);
  assert.equal(checkOffline(tx).ok, true);
  assert.equal(paysAddress(tx, to, 480).ok, true);
  const { type, msg } = encodePayment(tx);
  const reply = await smsGateway({ key: PrivateKey.fromRandom() }).handle("+1", paymentTexts(type, msg)[0]);
  assert.match(reply, /^BSV RECEIPT VALID_NOT_SENT/);
  assert.equal(parseCoinLine(lines[2].slice(0, -1) + "x"), null);
  assert.throws(() => announceLines({ config }), /key-file/);
});

test("claims: paid once per sender and address, signed receipt, then empty", async () => {
  const { master, config } = await faucet({ count: 2 });
  const sent = [];
  const f = faucetClaims({ master, config, broadcast: async (tx) => { sent.push(tx.id("hex")); return { ok: true, sent: true }; } });
  const a = addr();
  const r1 = await f.handle("+15550001", `BSV1 CLAIM ${a}`);
  assert.match(r1, /^BSV RECEIPT ACCEPTED [0-9a-f]{64}\nR1 .*\npaid 980 sat to /s);
  assert.equal(readReceiptText(r1, master.toPublicKey().toString()).status, "ACCEPTED");
  assert.match(await f.handle("+15550001", `BSV1 CLAIM ${addr()}`), /already claimed by this sender/);
  assert.match(await f.handle("+15550002", `BSV1 CLAIM ${a}`), /address already received/);
  assert.match(await f.handle("+15550003", "BSV1 CLAIM 1notanaddressatall000000000"), /REFUSED/);
  assert.equal(await f.handle("+15550003", "hello"), null);
  assert.match(await f.handle("+15550004", `BSV1 CLAIM ${addr()}`), /ACCEPTED/);
  assert.match(await f.handle("+15550005", `BSV1 CLAIM ${addr()}`), /EMPTY/);
  assert.equal(sent.length, 2);
  assert.equal(new Set(sent).size, 2);
});

test("claims: robots sign with a device key; the limit follows the key, not the sender", async () => {
  const { master, config } = await faucet({ count: 5 });
  const f = faucetClaims({ master, config });
  const robot = PrivateKey.fromRandom();
  assert.match(await f.handle("node-a", claimText(addr(), { id: config.id, deviceKey: robot })), /VALID_NOT_SENT/);
  assert.match(await f.handle("node-b", claimText(addr(), { id: config.id, deviceKey: robot })), /already claimed by this device/);
  assert.match(await f.handle("node-c", claimText(addr(), { id: "00000000", deviceKey: PrivateKey.fromRandom() })), /signature does not match/);
});

test("claims: a restart never pays a coin or a claimant twice; concurrent claims get different coins", async () => {
  const { master, config } = await faucet({ count: 6 });
  const dir = mkdtempSync(join(tmpdir(), "faucet-"));
  const first = faucetClaims({ master, config, dir });
  const replies = await Promise.all([1, 2, 3].map((n) => first.handle(`+1555000${n}`, `BSV1 CLAIM ${addr()}`)));
  const txids = replies.map((r) => r.match(/RECEIPT \S+ ([0-9a-f]{64})/)[1]);
  assert.equal(new Set(txids).size, 3);
  assert.deepEqual(first.records.map((r) => r.coin).sort(), [0, 1, 2]);
  const again = faucetClaims({ master, config, dir });
  assert.equal(again.left(), 3);
  assert.match(await again.handle("+15550001", `BSV1 CLAIM ${addr()}`), /already claimed/);
  assert.match(await again.handle("+15550009", `BSV1 CLAIM ${addr()}`), /VALID_NOT_SENT/);
  assert.equal(again.records.at(-1).coin, 3);
  assert.throws(() => faucetClaims({ master: PrivateKey.fromRandom(), config, dir }), /not the key/);
});

test("claims: a failed broadcast uses up the coin but not the claimant's turn", async () => {
  const { master, config } = await faucet({ count: 3 });
  let fail = true;
  const f = faucetClaims({ master, config, broadcast: async () => (fail ? { ok: false, sent: true, detail: "down" } : { ok: true, sent: true }) });
  const a = addr();
  assert.match(await f.handle("+1", `BSV1 CLAIM ${a}`), /ERROR/);
  fail = false;
  assert.match(await f.handle("+1", `BSV1 CLAIM ${a}`), /ACCEPTED/);
  assert.deepEqual(f.records.map((r) => r.coin), [0, 1]);
});

test("one number: claims and ordinary payments share it; ham refuses faucet traffic", async () => {
  const { master, config } = await faucet({ count: 2 });
  const both = combineHandlers(faucetClaims({ master, config }), smsGateway({ key: master }));
  assert.match(await both.handle("+1", `BSV1 CLAIM ${addr()}`), /paid 980 sat/);
  const { tx } = await demoPayment();
  const { type, msg } = encodePayment(tx);
  assert.match(await both.handle("+2", paymentTexts(type, msg)[0]), /^BSV RECEIPT VALID_NOT_SENT/);
  const lines = announceLines({ config: { ...config, mode: "bearer" }, master });
  for (const t of [announcement({ id: config.id, mode: "claims", coinSats: 1000, left: 2, count: 2 }), lines[1], `BSV1 CLAIM ${addr()}`]) assert.ok(hamRefusal(t), t.slice(0, 20));
});
