// The gateway: the radio that can reach the internet. It rebuilds payments from frames, checks
// them offline, hands valid ones to a broadcaster, and radios back a signed receipt. Missing
// frames are asked for with a NACK once a message has gone quiet for nackAfterMs.
//
// broadcast(tx) -> { ok, detail }. The default only checks and never sends (status
// VALID_NOT_SENT); arcBroadcaster() sends to BSV mainnet and is used only when the operator asks.
import { split, parse, reassembler, TYPE } from "./frame.mjs";
import { decodePayment, checkOffline, signReceipt, STATUS } from "./payment.mjs";
import { arcVerdict } from "./arc.mjs";

export const dryRun = async () => ({ ok: true, sent: false, detail: "dry run: checked, not broadcast" });

export function arcBroadcaster(url = "https://arc.gorillapool.io") {
  return async (tx) => {
    const r = await fetch(`${url}/v1/tx`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ rawTx: tx.toHexEF() }) });
    const text = await r.text();
    const v = arcVerdict(r.status, text); // the txStatus decides: ARC can answer 200 for an orphan
    return { ok: v.ok, sent: true, detail: v.ok ? `${url}: ${v.txStatus}` : `${url}: ${v.why}` };
  };
}

// Decode, check offline, broadcast if valid, sign the receipt. Shared by every transport (radio,
// SMS). Never throws for a bad payment: it gets a REJECTED receipt.
export async function settlePayment({ type, id, msg, key, broadcast = dryRun }) {
  let tx, check;
  try { tx = decodePayment(type, msg); check = checkOffline(tx); } catch (e) { check = { ok: false, reason: e.message, txid: "00".repeat(32) }; }
  let status = STATUS.REJECTED, detail = check.reason;
  if (check.ok) {
    const b = await broadcast(tx).catch((e) => ({ ok: false, sent: true, detail: e.message }));
    status = !b.ok ? STATUS.BROADCAST_FAILED : b.sent ? STATUS.ACCEPTED : STATUS.VALID_NOT_SENT;
    detail = b.detail;
  }
  return { tx, check, status, detail, receipt: signReceipt({ txid: check.txid, status, id }, key) };
}

export function startGateway({ radio, key, broadcast = dryRun, mtu, nackAfterMs = 1500, maxNacks = 5, log = () => {} }) {
  const parts = reassembler();
  const done = new Map(); // message id -> receipt frames, so a lost receipt can be sent again
  const nacks = new Map();
  const events = [];
  const emit = (e) => { events.push(e); log(e); };

  radio.onFrame(async (raw) => {
    const p = parse(raw);
    if (!p || (p.type !== TYPE.PAY_EF && p.type !== TYPE.PAY_BEEF)) return;
    if (done.has(p.id)) { // sender is still repeating: its receipt went missing
      const d = done.get(p.id);
      if (Date.now() - d.at < nackAfterMs / 2) return; // once per burst of repeats
      d.at = Date.now();
      for (const f of d.frames) await radio.send(f);
      return;
    }
    const whole = parts.add(p);
    if (!whole) return;
    if (whole.corrupt) { emit({ ev: "corrupt", id: p.id }); return; }
    await settle(whole);
  });

  async function settle({ type, id, msg }) {
    const { check, status, detail, receipt } = await settlePayment({ type, id, msg, key, broadcast });
    const frames = split(TYPE.RECEIPT, receipt, { mtu, id: Buffer.from(id, "hex") });
    done.set(id, { frames, at: Date.now() });
    emit({ ev: "payment", id, txid: check.txid, ok: check.ok, status, detail, bytes: msg.length, fee: check.fee });
    for (const f of frames) await radio.send(f);
  }

  // Ask for what is missing on messages that have gone quiet.
  const timer = setInterval(async () => {
    for (const m of parts.pending()) {
      const prev = nacks.get(m.id) ?? { n: 0, at: 0 };
      if (Date.now() - Math.max(m.last, prev.at) < nackAfterMs) continue;
      const n = prev.n + 1;
      if (n > maxNacks) { parts.drop(m.id); nacks.delete(m.id); emit({ ev: "gave-up", id: m.id }); continue; }
      nacks.set(m.id, { n, at: Date.now() });
      const missing = parts.missing(m.id);
      emit({ ev: "nack", id: m.id, missing });
      for (const f of split(TYPE.NACK, Buffer.from(missing), { mtu, id: Buffer.from(m.id, "hex") })) await radio.send(f);
    }
  }, Math.max(10, Math.floor(nackAfterMs / 3)));

  return { events, stop() { clearInterval(timer); } };
}
