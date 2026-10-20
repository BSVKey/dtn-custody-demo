// The SMS gateway: payments arrive as texts, are checked offline, broadcast only when the operator
// asked for it, and are answered with a text carrying the gateway's signed receipt. Transport-free:
// the adapters in server.mjs feed it texts and send its replies.
//
//   const gw = smsGateway({ key });           // dry run: checks, never broadcasts
//   const reply = await gw.handle(from, body); // null when there is nothing to send back
import { settlePayment, dryRun } from "../lib/gateway.mjs";
import { STATUS } from "../lib/payment.mjs";
import { parseText, textAssembler, receiptText } from "./text.mjs";

const NAME = Object.fromEntries(Object.entries(STATUS).map(([k, v]) => [v, k]));

export function smsGateway({ key, broadcast = dryRun, log = () => {} }) {
  const parts = textAssembler();
  const done = new Map(); // payment id -> reply text: a repeat gets the same receipt, no new broadcast
  const events = [];
  const emit = (e) => { events.push(e); log(e); };

  async function handle(from, body) {
    const p = parseText(body);
    if (!p) { emit({ ev: "ignored", from }); return null; } // not ours: never reply, so no text loops
    const whole = parts.add(from, p);
    if (!whole) { emit({ ev: "part", from, id: p.id, part: p.part, of: p.of }); return null; }
    if (whole.corrupt) { emit({ ev: "corrupt", from, id: whole.id }); return `BSV ERROR parts of ${whole.id} do not match; send the payment again`; }
    if (done.has(whole.id)) { emit({ ev: "repeat", from, id: whole.id }); return done.get(whole.id); }
    const { check, status, detail, receipt } = await settlePayment({ type: whole.type, id: whole.id, msg: whole.msg, key, broadcast });
    let reply = receiptText({ status: NAME[status], txid: check.txid, receipt });
    if (status === STATUS.REJECTED) reply += `\nwhy: ${String(detail).slice(0, 80)}`;
    done.set(whole.id, reply);
    emit({ ev: "payment", from, id: whole.id, txid: check.txid, ok: check.ok, status, detail, fee: check.fee });
    return reply;
  }

  return { handle, events };
}
