// What an ARC broadcaster's answer means. ARC can answer HTTP 200 for a transaction the network
// will never mine: an orphan (it spends coins the node has never seen, such as a demo payment's
// made-up funding) or a double spend. So the txStatus in the body decides, not the HTTP code.
//
//   arcVerdict(httpStatus, bodyText) -> { ok, txStatus, why }
const GOOD = new Set(["STORED", "ANNOUNCED_TO_NETWORK", "REQUESTED_BY_NETWORK", "SENT_TO_NETWORK", "ACCEPTED_BY_NETWORK", "SEEN_ON_NETWORK", "MINED"]);
const WHY = {
  SEEN_IN_ORPHAN_MEMPOOL: "the network has never seen the coins it spends, so it cannot be mined (a demo payment, or its funding was never broadcast)",
  DOUBLE_SPEND_ATTEMPTED: "the coins it spends were already spent by another payment",
  REJECTED: "the network refused it",
};

export function arcVerdict(httpStatus, bodyText) {
  let j = null;
  try { j = JSON.parse(bodyText); } catch {}
  const txStatus = j?.txStatus ?? null;
  if (txStatus) {
    if (GOOD.has(txStatus)) return { ok: true, txStatus, why: null };
    const extra = j.extraInfo ? ` (${String(j.extraInfo).slice(0, 120)})` : "";
    return { ok: false, txStatus, why: (WHY[txStatus] ?? `status ${txStatus}`) + extra };
  }
  // no status in the body: an error answer, or "already known" for a repeat of an accepted payment
  if (/already (known|in the mempool|mined)|txn-already-known/i.test(bodyText)) return { ok: true, txStatus: "ALREADY_KNOWN", why: null };
  const detail = j?.detail || j?.title || String(bodyText).slice(0, 160);
  return { ok: false, txStatus: null, why: `refused (${httpStatus}): ${detail}` };
}
