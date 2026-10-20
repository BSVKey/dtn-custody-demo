// Claims mode: the faucet answers "BSV1 CLAIM <address>" texts (SMS, or any link that carries
// text) by paying one coin, within limits, and replying with a receipt signed by the faucet key.
//
// Limits: one claim per sender (phone number, radio node) by default, or per device key when the
// claim is signed by one (for robots), and one per address. A device key is free to make, so a
// per-key limit stops honest robots from double-claiming, not a determined cheat; phone numbers
// are harder to come by. Claims are handled one at a time and written to claims.jsonl before the
// reply, so a restart never pays the same coin or the same claimant twice.
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { dryRun } from "../lib/gateway.mjs";
import { signReceipt, STATUS } from "../lib/payment.mjs";
import { receiptText } from "../sms/text.mjs";
import { coinKey, spendCoin, parseClaim, faucetId } from "./faucet.mjs";

const NAME = Object.fromEntries(Object.entries(STATUS).map(([k, v]) => [v, k]));

// config: { id, funding, fanoutTxid, coinSats, count, feeRate }, from faucet.json
export function faucetClaims({ master, config, dir, broadcast = dryRun, perSender = 1, perAddress = 1, log = () => {} }) {
  const id = faucetId(master, config.funding);
  if (config.id && config.id !== id) throw new Error("this key is not the key of this faucet");
  const ledger = dir ? join(dir, "claims.jsonl") : null;
  const records = [];
  if (ledger && existsSync(ledger)) for (const line of readFileSync(ledger, "utf8").split("\n")) if (line) records.push(JSON.parse(line));
  const used = new Set(records.map((r) => r.coin));
  const count = (k, v) => records.filter((r) => r.ok && r[k] === v).length;
  let queue = Promise.resolve();

  const record = (r) => { records.push(r); used.add(r.coin); if (ledger) appendFileSync(ledger, JSON.stringify(r) + "\n"); };

  async function claim(from, body) {
    const c = parseClaim(body, id);
    if (!c) return null; // not a claim: someone else may handle it
    if (c.bad) return `BSV FAUCET REFUSED ${c.bad}`;
    const who = c.device ? `key:${c.device}` : `from:${from}`;
    if (count("who", who) >= perSender) return `BSV FAUCET REFUSED already claimed by this ${c.device ? "device" : "sender"}`;
    if (count("to", c.address) >= perAddress) return "BSV FAUCET REFUSED this address already received a coin";
    let coin = 0;
    while (coin < config.count && used.has(coin)) coin++;
    if (coin >= config.count) return `BSV FAUCET EMPTY all ${config.count} coins are claimed`;
    const tx = await spendCoin({ key: coinKey(master, config.funding, coin), txid: config.fanoutTxid, vout: coin, sats: config.coinSats, to: c.address, feeRate: config.feeRate });
    const b = await broadcast(tx).catch((e) => ({ ok: false, sent: true, detail: e.message }));
    const status = !b.ok ? STATUS.BROADCAST_FAILED : b.sent ? STATUS.ACCEPTED : STATUS.VALID_NOT_SENT;
    const txid = tx.id("hex"), paid = tx.outputs[0].satoshis;
    // a failed broadcast still uses up the coin: it may have gone through, and it is never paid twice
    record({ at: new Date().toISOString(), coin, who, to: c.address, txid, sats: paid, status: NAME[status], ok: b.ok, detail: b.detail });
    log({ ev: "claim", coin, who, to: c.address, txid, status: NAME[status], detail: b.detail });
    if (!b.ok) return `BSV FAUCET ERROR the payment could not be sent; try again later`;
    const receipt = signReceipt({ txid, status, id: id + "00000000" }, master);
    return `${receiptText({ status: NAME[status], txid, receipt })}\npaid ${paid} sat to ${c.address}`;
  }

  return {
    id,
    // one claim at a time, so two claims can never take the same coin
    handle(from, body) { const p = queue.then(() => claim(from, body)); queue = p.catch(() => {}); return p; },
    left: () => config.count - used.size,
    records,
  };
}

// Several text handlers on one number: the first that answers wins.
export const combineHandlers = (...hs) => ({ async handle(from, body) { for (const h of hs) { const r = await h.handle(from, body); if (r != null) return r; } return null; } });
