// Radio payments (radio/), offline: frames that fit a LoRa packet, offline payment checks,
// signed gateway receipts, and the payer-to-gateway exchange over a simulated lossy link.
// Synthetic funding; nothing is broadcast.
import { test } from "node:test";
import assert from "node:assert/strict";
import { PrivateKey, P2PKH } from "@bsv/sdk";
import { split, parse, reassembler, airtimeMs, TYPE, DEFAULT_MTU } from "../radio/lib/frame.mjs";
import { checkOffline, paysAddress, encodePayment, decodePayment, signReceipt, readReceipt, STATUS } from "../radio/lib/payment.mjs";
import { loraLink } from "../radio/lib/link.mjs";
import { startGateway } from "../radio/lib/gateway.mjs";
import { sendPayment } from "../radio/lib/sender.mjs";
import { demoPayment } from "../radio/run-demo.mjs";

test("frames: fit the MTU, reassemble in any order, and a corrupted message is caught", () => {
  const msg = Buffer.from(Array.from({ length: 1000 }, (_, i) => i % 251));
  const frames = split(TYPE.PAY_EF, msg);
  assert.ok(frames.every((f) => f.length <= DEFAULT_MTU));
  assert.equal(frames.length, Math.ceil(1000 / (DEFAULT_MTU - 13)));
  const r = reassembler();
  let out = null;
  for (const f of [...frames].reverse()) out = r.add(parse(f)) ?? out;
  assert.deepEqual(out.msg, msg);

  const r2 = reassembler(), bad = frames.map((f) => Buffer.from(f));
  bad[2][20] ^= 1;
  let got = null;
  for (const f of bad) got = r2.add(parse(f)) ?? got;
  assert.equal(got.corrupt, true);

  const r3 = reassembler();
  r3.add(parse(frames[0]));
  assert.deepEqual(r3.missing(parse(frames[0]).id), [...Array(frames.length).keys()].slice(1));
  assert.equal(parse(Buffer.from("hello from someone else's app")), null);
  assert.throws(() => split(TYPE.PAY_EF, Buffer.alloc(256 * 187)));
});

test("airtime: matches the Semtech formula (SF7/125 kHz, 10 bytes, 8-symbol preamble = 41.2 ms)", () => {
  assert.equal(airtimeMs(10, { sf: 7, bwHz: 125_000, cr: 1, preamble: 8, overhead: 0 }).toFixed(1), "41.2");
  assert.ok(airtimeMs(200) > airtimeMs(200, { sf: 7, bwHz: 250_000, cr: 1 }));
});

test("offline check: a valid payment passes; a changed amount, a wrong key or a missing input amount fails", async () => {
  const { tx, to, sats } = await demoPayment();
  assert.equal(checkOffline(tx).ok, true);
  assert.deepEqual(paysAddress(tx, to, sats), { ok: true, got: sats });
  assert.equal(paysAddress(tx, to, sats + 1).ok, false);

  for (const type of [TYPE.PAY_EF, TYPE.PAY_BEEF]) {
    const { msg } = encodePayment(tx, { beef: type === TYPE.PAY_BEEF });
    const back = decodePayment(type, msg);
    assert.equal(back.id("hex"), tx.id("hex"));
    assert.equal(checkOffline(back).ok, true);
  }

  const raised = decodePayment(TYPE.PAY_EF, encodePayment(tx).msg);
  raised.outputs[0].satoshis += 500;
  assert.equal(checkOffline(raised).ok, false);

  const thief = await demoPayment();
  const stolen = decodePayment(TYPE.PAY_EF, encodePayment(thief.tx).msg);
  stolen.inputs[0].sourceTransaction.outputs[0].lockingScript = new P2PKH().lock(PrivateKey.fromRandom().toAddress());
  assert.equal(checkOffline(stolen).ok, false);

  const raw = decodePayment(TYPE.PAY_EF, encodePayment(tx).msg);
  raw.inputs[0].sourceTransaction = undefined;
  assert.match(checkOffline(raw).reason, /missing/);
});

test("receipts: fit one frame, verify against the pinned gateway key only, and resist tampering", () => {
  const gw = PrivateKey.fromRandom(), pin = gw.toPublicKey().toString();
  const rec = signReceipt({ txid: "ab".repeat(32), status: STATUS.ACCEPTED, id: "01".repeat(8) }, gw);
  assert.equal(split(TYPE.RECEIPT, rec).length, 1);
  assert.equal(readReceipt(rec, pin).status, "ACCEPTED");
  assert.equal(readReceipt(rec, PrivateKey.fromRandom().toPublicKey().toString()), null);
  const t = Buffer.from(rec); t[32] = STATUS.REJECTED;
  assert.equal(readReceipt(t, pin), null);
});

async function exchange({ loss = 0, seed = 1, drop, tx, broadcast }) {
  const link = loraLink({ loss, seed, drop });
  const key = PrivateKey.fromRandom();
  const gw = startGateway({ radio: link.b, key, nackAfterMs: 40, broadcast });
  tx ??= (await demoPayment()).tx;
  const res = await sendPayment({ radio: link.a, tx, gatewayPub: key.toPublicKey().toString(), waitMs: 150, tries: 8 });
  gw.stop();
  return { res, gw, link, tx };
}

test("exchange: a payment crosses a 30% loss link and comes back with a matching signed receipt", async () => {
  for (const seed of [1, 2, 3, 4, 5]) {
    const { res, tx } = await exchange({ loss: 0.3, seed });
    assert.ok(res.receipt, `seed ${seed}: no receipt`);
    assert.equal(res.receipt.txid, tx.id("hex"));
    assert.equal(res.receipt.status, "VALID_NOT_SENT");
  }
});

test("exchange: a lost frame is NACKed and resent alone; a lost receipt is sent again; broadcast happens once", async () => {
  let calls = 0;
  const broadcast = async () => { calls++; return { ok: true, sent: true, detail: "test" }; };
  // drop the payment's first frame once, and the first receipt
  const seen = new Set();
  const drop = (f) => {
    const p = parse(f), k = `${p.type}:${p.index}`;
    if ((p.type === TYPE.PAY_EF && p.index === 0) || p.type === TYPE.RECEIPT) { if (!seen.has(k)) { seen.add(k); return true; } }
    return false;
  };
  const { res, gw } = await exchange({ drop, broadcast });
  assert.equal(res.receipt.status, "ACCEPTED");
  assert.equal(calls, 1);
  assert.ok(gw.events.some((e) => e.ev === "nack" && e.missing.includes(0)));
});

test("exchange: an invalid payment is rejected by the gateway and never broadcast", async () => {
  let calls = 0;
  const { tx } = await demoPayment();
  const bad = decodePayment(TYPE.PAY_EF, encodePayment(tx).msg);
  bad.outputs[0].satoshis += 1;
  const { res } = await exchange({ tx: bad, broadcast: async () => { calls++; return { ok: true, sent: true }; } });
  assert.equal(res.receipt.status, "REJECTED");
  assert.equal(calls, 0);
});

test("cli: builds a radio payment offline from a saved funding transaction", async () => {
  const { buildRadioPayment } = await import("../radio/cli.mjs");
  const payer = PrivateKey.fromRandom(), to = PrivateKey.fromRandom().toAddress();
  const { tx: fundTx } = await demoPayment({ to: payer.toAddress(), sats: 5000 });
  const tx = await buildRadioPayment({ payer, fundTx, to, sats: 1200 });
  assert.equal(checkOffline(tx).ok, true);
  assert.equal(paysAddress(tx, to, 1200).ok, true);
  await assert.rejects(buildRadioPayment({ payer: PrivateKey.fromRandom(), fundTx, to, sats: 1 }), /does not pay/);
});
