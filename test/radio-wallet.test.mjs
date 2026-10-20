// Loading a wallet to send real BSV (radio/lib/wallet.mjs), offline: keys, recovery phrases and
// BSVKey wallet files load (and a file whose address does not match its key is refused); coins
// are read from WhatsOnChain-shaped answers (a stand-in network) and checked against their
// transactions; payments spend just enough and fail plainly when there is not enough.
import { test } from "node:test";
import assert from "node:assert/strict";
import { PrivateKey, Mnemonic, HD } from "@bsv/sdk";
import { importWallet, fetchCoins, buildFromCoins, DEFAULT_PATH, WOC } from "../radio/lib/wallet.mjs";
import { demoPayment, checkOffline, paysAddress } from "../radio/lib/payment.mjs";

test("import: private key, recovery phrase and wallet file; bad input is refused plainly", () => {
  const k = PrivateKey.fromRandom();
  assert.equal(importWallet(k.toWif()).address, k.toAddress());
  const m = Mnemonic.fromRandom(), phrase = m.toString();
  const want = HD.fromSeed(m.toSeed()).derive(DEFAULT_PATH).privKey.toAddress();
  assert.equal(importWallet(`  ${phrase.toUpperCase()}  `).address, want);
  const file = JSON.stringify({ type: "bsv-wallet", address: want, mnemonic: phrase, derivation: DEFAULT_PATH });
  assert.equal(importWallet(file).kind, "wallet file (recovery phrase)");
  assert.throws(() => importWallet(JSON.stringify({ address: k.toAddress(), mnemonic: phrase })), /not loaded/);
  assert.equal(importWallet(JSON.stringify({ wif: k.toWif() })).address, k.toAddress());
  // A fixed phrase (BIP-39 vector "legal winner ...") with its first two words swapped: a random
  // phrase would be flaky, since a 4-bit checksum lets about 1 swap in 16 still check out.
  assert.throws(() => importWallet("winner legal thank year wave sausage worth useful legal winner thank yellow"), /does not check out|misspelled/);
  assert.throws(() => importWallet("one two three"), /12, 15/);
  assert.throws(() => importWallet(""), /paste/);
  assert.throws(() => importWallet("{not json"), /not a wallet file/);
});

async function coinsFor(key, amounts) {
  const txs = [];
  for (const sats of amounts) txs.push((await demoPayment({ to: key.toAddress(), sats, fund: sats + 2000 })).tx);
  const utxos = txs.map((tx, i) => ({ height: 1, tx_pos: 0, tx_hash: tx.id("hex"), value: amounts[i], isSpentInMempoolTx: false }));
  const get = async (url) => {
    if (url === `${WOC}/address/${key.toAddress()}/unspent/all`) return Response.json({ result: utxos.map((u, i) => ({ ...u, status: i === utxos.length - 1 ? "unconfirmed" : "confirmed" })) });
    const tx = txs.find((t) => url === `${WOC}/tx/${t.id("hex")}/hex`);
    return tx ? new Response(tx.toHex()) : new Response("no", { status: 404 });
  };
  return { txs, get };
}

test("coins: confirmed and unconfirmed, largest first, each checked against its transaction", async () => {
  const key = PrivateKey.fromRandom();
  const { get } = await coinsFor(key, [3000, 9000, 500]);
  const coins = await fetchCoins(key.toAddress(), { get });
  assert.deepEqual(coins.map((c) => c.sats), [9000, 3000, 500]);
  const lying = async (url) => { const r = await get(url); if (url.includes("/unspent/all")) { const j = await r.json(); j.result[0].value += 1; return Response.json(j); } return r; };
  await assert.rejects(fetchCoins(key.toAddress(), { get: lying }), /does not match/);
  assert.deepEqual(await fetchCoins(PrivateKey.fromRandom().toAddress(), { get: async () => new Response("Not Found", { status: 404 }) }), []);
  await assert.rejects(fetchCoins(key.toAddress(), { get: async () => new Response("busy", { status: 503 }) }), /did not answer/);
});

test("pay: spends just enough coins, change comes back, and not-enough is refused", async () => {
  const key = PrivateKey.fromRandom(), to = PrivateKey.fromRandom().toAddress();
  const { get } = await coinsFor(key, [3000, 9000, 500]);
  const coins = await fetchCoins(key.toAddress(), { get });
  const small = await buildFromCoins({ key, coins, to, sats: 5000 });
  assert.equal(small.inputs.length, 1);
  assert.equal(checkOffline(small).ok, true);
  assert.equal(paysAddress(small, to, 5000).ok, true);
  assert.ok(paysAddress(small, key.toAddress(), 3900).ok);
  const big = await buildFromCoins({ key, coins, to, sats: 11_000 });
  assert.equal(big.inputs.length, 2);
  assert.equal(checkOffline(big).ok, true);
  await assert.rejects(buildFromCoins({ key, coins, to, sats: 12_500 }), /not enough/);
  await assert.rejects(buildFromCoins({ key, coins, to: "not-an-address", sats: 10 }));
});
