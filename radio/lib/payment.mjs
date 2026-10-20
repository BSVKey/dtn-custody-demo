// Payments and receipts that travel over radio.
//
// A payment goes as Extended Format (EF): the raw transaction plus, for each input, the amount
// and locking script it spends. That is enough to check every signature and the amounts with no
// internet at all, and ARC accepts it as is. BEEF (BRC-62) can go instead when the sender holds
// the parents and their Merkle proofs; it lets the gateway also check the coins exist, against
// block headers it already has.
//
// What an offline check cannot show is that the coins were not spent elsewhere first. That is
// only settled once the gateway broadcasts, so treat an unbroadcast radio payment like a cheque:
// fine for small amounts, wait for the receipt for large ones.
import { createHash } from "node:crypto";
import { Transaction, P2PKH, Spend, PublicKey, PrivateKey, Signature, SatoshisPerKilobyte } from "@bsv/sdk";
import { TYPE } from "./frame.mjs";

export function encodePayment(tx, { beef = false } = {}) {
  return beef ? { type: TYPE.PAY_BEEF, msg: Buffer.from(tx.toBEEF(true)) } : { type: TYPE.PAY_EF, msg: Buffer.from(tx.toEF()) };
}

export function decodePayment(type, msg) {
  if (type === TYPE.PAY_EF) return Transaction.fromEF([...msg]);
  if (type === TYPE.PAY_BEEF) return Transaction.fromBEEF([...msg]);
  throw new Error(`not a payment frame type: ${type}`);
}

// Every input's unlocking script runs against the output it spends; inputs must cover outputs.
// Returns { ok, reason, txid, fee, outputs } and never throws for a bad payment.
export function checkOffline(tx) {
  const txid = tx.id("hex");
  try {
    if (!tx.inputs.length || !tx.outputs.length) return { ok: false, txid, reason: "no inputs or no outputs" };
    let inSats = 0;
    for (const [i, input] of tx.inputs.entries()) {
      const src = input.sourceTransaction?.outputs?.[input.sourceOutputIndex];
      if (!src) return { ok: false, txid, reason: `input ${i}: amount and locking script are missing` };
      inSats += src.satoshis;
      const spend = new Spend({
        sourceTXID: input.sourceTXID ?? input.sourceTransaction.id("hex"),
        sourceOutputIndex: input.sourceOutputIndex,
        lockingScript: src.lockingScript,
        sourceSatoshis: src.satoshis,
        transactionVersion: tx.version,
        otherInputs: tx.inputs.filter((_, j) => j !== i),
        allInputs: tx.inputs,
        unlockingScript: input.unlockingScript,
        inputSequence: input.sequence ?? 0xffffffff,
        inputIndex: i,
        outputs: tx.outputs,
        lockTime: tx.lockTime,
      });
      if (!spend.validate()) return { ok: false, txid, reason: `input ${i}: script did not validate` };
    }
    const outSats = tx.outputs.reduce((s, o) => s + o.satoshis, 0);
    if (inSats < outSats) return { ok: false, txid, reason: `outputs ${outSats} sat exceed inputs ${inSats} sat` };
    return { ok: true, txid, fee: inSats - outSats, outputs: tx.outputs.map((o) => ({ satoshis: o.satoshis, script: o.lockingScript.toHex() })) };
  } catch (e) {
    return { ok: false, txid, reason: e.message.split("\n")[0] };
  }
}

// What a payee with a radio and no internet checks before handing over the goods.
export function paysAddress(tx, address, minSats) {
  const want = new P2PKH().lock(address).toHex();
  const got = tx.outputs.filter((o) => o.lockingScript.toHex() === want).reduce((s, o) => s + o.satoshis, 0);
  return { ok: got >= minSats, got };
}

// Receipt: the gateway's signed statement about what it did with a payment. Fits one frame.
//   txid 32 | status 1 | unix time 4 | message id 8 | gateway pubkey 33 | DER signature
export const STATUS = { ACCEPTED: 1, VALID_NOT_SENT: 2, REJECTED: 3, BROADCAST_FAILED: 4 };
const STATUS_NAME = Object.fromEntries(Object.entries(STATUS).map(([k, v]) => [v, k]));
const DOMAIN = Buffer.from("bsvkey-radio-receipt/1");

const digest = (body) => createHash("sha256").update(DOMAIN).update(body).digest();

export function signReceipt({ txid, status, time = Math.floor(Date.now() / 1000), id }, gatewayKey) {
  const body = Buffer.alloc(45);
  Buffer.from(txid, "hex").copy(body, 0); body[32] = status; body.writeUInt32BE(time, 33); Buffer.from(id, "hex").copy(body, 37);
  const pub = Buffer.from(gatewayKey.toPublicKey().encode(true));
  const sig = Buffer.from(gatewayKey.sign([...digest(Buffer.concat([body, pub]))]).toDER());
  return Buffer.concat([body, pub, sig]);
}

// pinnedPub: the gateway key the sender trusts (hex). Returns null if the receipt is not valid.
export function readReceipt(buf, pinnedPub) {
  const b = Buffer.from(buf);
  if (b.length < 45 + 33 + 8) return null;
  const body = b.subarray(0, 45), pub = b.subarray(45, 78), sig = b.subarray(78);
  if (pinnedPub && pub.toString("hex") !== pinnedPub.toLowerCase()) return null;
  try {
    const ok = PublicKey.fromString(pub.toString("hex")).verify([...digest(Buffer.concat([body, pub]))], Signature.fromDER([...sig]));
    if (!ok) return null;
  } catch { return null; }
  return { txid: body.subarray(0, 32).toString("hex"), status: STATUS_NAME[body[32]] ?? `UNKNOWN(${body[32]})`, time: body.readUInt32BE(33), id: body.subarray(37, 45).toString("hex"), gateway: pub.toString("hex") };
}

// Build and sign offline: spend the output of fundTx that pays the payer key.
export async function buildRadioPayment({ payer, fundTx, to, sats, feeRate = 100 }) {
  const ours = new P2PKH().lock(payer.toAddress()).toHex();
  const vout = fundTx.outputs.findIndex((o) => o.lockingScript.toHex() === ours);
  if (vout < 0) throw new Error(`funding transaction does not pay ${payer.toAddress()}`);
  if (fundTx.outputs[vout].satoshis < sats) throw new Error(`funding output has ${fundTx.outputs[vout].satoshis} sat; payment is ${sats} plus fee`);
  const tx = new Transaction();
  tx.addInput({ sourceTransaction: fundTx, sourceOutputIndex: vout, unlockingScriptTemplate: new P2PKH().unlock(payer) });
  tx.addOutput({ lockingScript: new P2PKH().lock(to), satoshis: sats });
  tx.addOutput({ lockingScript: new P2PKH().lock(payer.toAddress()), change: true });
  await tx.fee(new SatoshisPerKilobyte(feeRate));
  await tx.sign();
  return tx;
}

// A payment from a synthetic funding output. Offline: nothing is fetched or sent.
export async function demoPayment({ payer = PrivateKey.fromRandom(), to = PrivateKey.fromRandom().toAddress(), sats = 1000, fund = 10_000, feeRate = 100 } = {}) {
  const src = new Transaction();
  src.addInput({ sourceTXID: "11".repeat(32), sourceOutputIndex: 0, unlockingScript: new P2PKH().lock(payer.toAddress()), sequence: 0xffffffff });
  src.addOutput({ lockingScript: new P2PKH().lock(payer.toAddress()), satoshis: fund });
  const tx = new Transaction();
  tx.addInput({ sourceTransaction: src, sourceOutputIndex: 0, unlockingScriptTemplate: new P2PKH().unlock(payer) });
  tx.addOutput({ lockingScript: new P2PKH().lock(to), satoshis: sats });
  tx.addOutput({ lockingScript: new P2PKH().lock(payer.toAddress()), change: true });
  await tx.fee(new SatoshisPerKilobyte(feeRate));
  await tx.sign();
  return { tx, to, sats };
}
