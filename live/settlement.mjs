// Live BSV settlement verification (zero dependency, WhatsOnChain mainnet). Turns the
// delivery receipt's placeholder settlementRef into a REAL, on-chain-verified payment:
// the txid the verifier bound to is fetched from the chain and confirmed to pay the
// receipt's payTo the receipt's amount, with enough confirmations. Read-only, keyless.
//
// This composes with bindDelivery (agent/lib/receipt.mjs): bindDelivery proves the
// receipt names the txid the verifier itself paid; verifySettlementOnChain proves that
// txid actually moved the funds. Both are required for "delivered for MY paid call".

const WOC = "https://api.whatsonchain.com/v1/bsv/main";

async function wocFetch(path, { tries = 4 } = {}) {
  let last;
  for (let i = 0; i < tries; i++) {
    const r = await fetch(`${WOC}${path}`);
    if (r.ok) return r;
    last = r;
    if (r.status === 429) { await new Promise((res) => setTimeout(res, 1200 * (i + 1))); continue; }
    throw new Error(`WhatsOnChain ${r.status} for ${path}`);
  }
  throw new Error(`WhatsOnChain ${last?.status ?? "error"} for ${path} after ${tries} tries`);
}

// Confirm txid pays >= minSats to payTo on chain, with >= minConf confirmations.
export async function verifySettlementOnChain(txid, { payTo, minSats = 1, minConf = 1 } = {}) {
  if (!txid || !payTo) return { ok: false, reason: "need txid and payTo" };
  let j;
  try { j = await (await wocFetch(`/tx/hash/${txid}`)).json(); }
  catch (e) { return { ok: false, reason: `chain_read_failed: ${e.message}`, txid }; }
  let paidSats = 0;
  for (const o of j.vout || []) {
    const addrs = o.scriptPubKey && o.scriptPubKey.addresses;
    if (addrs && addrs.includes(payTo)) paidSats += Math.round(Number(o.value) * 1e8);
  }
  const confirmations = Number(j.confirmations) || 0;
  const ok = paidSats >= minSats && confirmations >= minConf;
  return {
    ok, txid, payTo, paidSats, confirmations,
    reason: ok ? undefined : (paidSats < minSats ? "underpaid_or_wrong_payee" : "insufficient_confirmations"),
  };
}
