// The sender: radios a signed payment to a gateway and waits for the gateway's signed receipt.
// A NACK resends just the frames it lists; silence resends the whole payment, up to `tries`.
// The receipt is accepted only if it is signed by the pinned gateway key and names this txid.
import { split, parse, reassembler, TYPE } from "./frame.mjs";
import { encodePayment, readReceipt } from "./payment.mjs";

export async function sendPayment({ radio, tx, gatewayPub, beef = false, mtu, waitMs = 8000, tries = 4, log = () => {} }) {
  const { type, msg } = encodePayment(tx, { beef });
  const frames = split(type, msg, { mtu });
  const id = parse(frames[0]).id, txid = tx.id("hex");
  const parts = reassembler({ verifyHash: false }); // NACK and receipt frames carry the payment's id
  let wake, receipt = null, resend = null;

  radio.onFrame((raw) => {
    const p = parse(raw);
    if (!p || p.id !== id) return;
    const whole = parts.add(p);
    if (!whole) return;
    if (whole.type === TYPE.NACK) { resend = [...whole.msg].filter((i) => i < frames.length); wake?.(); }
    if (whole.type === TYPE.RECEIPT) {
      const r = readReceipt(whole.msg, gatewayPub);
      if (r && r.txid === txid) { receipt = r; wake?.(); } else log({ ev: "bad-receipt" });
    }
  });

  log({ ev: "send", id, txid, bytes: msg.length, frames: frames.length, format: beef ? "BEEF" : "EF" });
  let toSend = frames.map((_, i) => i), attempt = 0;
  while (!receipt && attempt < tries) {
    attempt++;
    resend = null;
    for (const i of toSend) await radio.send(frames[i]);
    // a NACK or a receipt wakes us early; a NACK answered does not use up a try (the gateway
    // stops asking after its own limit)
    if (!receipt && !resend) await new Promise((r) => { wake = r; setTimeout(r, waitMs); });
    wake = null;
    if (receipt) break;
    if (resend) { log({ ev: "resend", frames: resend }); toSend = resend; attempt--; }
    else { toSend = frames.map((_, i) => i); log({ ev: "timeout", attempt }); }
  }
  return { id, txid, frames: frames.length, bytes: msg.length, receipt };
}
