// Amateur (ham) radio profile: coded, locked, and not used by this project.
//
// US amateur rules (FCC Part 97) forbid traffic in which anyone has a money interest (97.113),
// messages encoded to obscure their meaning (97.113), and require the station's callsign at
// least every 10 minutes and at the end of a transmission (97.119). So this profile:
//   - refuses payments, receipts, faucet coins and claims, in every format this repo makes,
//   - refuses long base64 or hex runs, so nothing opaque can ride along,
//   - only passes short plain-text messages, such as a test beacon,
//   - sends "DE <callsign>" first, then at least every 9.5 minutes of airtime, and last.
// ggwave is publicly documented, so the ID can be read with the same decoder. Whether a given
// transmission is lawful is the licensed operator's call, not this code's. Other countries have
// their own rules.
const CALLSIGN = /^(?=.{3,8}$)[A-Z0-9]{1,3}[0-9][A-Z0-9]{0,3}[A-Z]$/;
const ID_EVERY_S = 9.5 * 60;

const PAYMENT_LIKE = [
  /^S[1-9a-z]{2}[EB][0-9a-f]{8}/, // sound chunk of a payment
  /\bBSV1\b/i, // SMS / QR payment text
  /\bBSV RECEIPT\b|\bR1 [A-Za-z0-9+/=]{20,}/, // gateway receipt
  /^[FC][1-9a-z]{2}/, // faucet coin or claim chunk
];
const OPAQUE = /[A-Za-z0-9+/=]{24,}|[0-9a-f]{24,}/i;

export function hamRefusal(text) {
  const t = String(text ?? "");
  if (PAYMENT_LIKE.some((r) => r.test(t))) return "payment traffic is not allowed on amateur bands";
  if (OPAQUE.test(t.replace(/^DE [A-Z0-9]+$/, ""))) return "long encoded data is not allowed: it could obscure the meaning";
  if (!/^[\x20-\x7e]{1,140}$/.test(t)) return "only short plain-text messages (printable ASCII, up to 140 characters)";
  return null;
}

// Wraps a list of plain-text messages with station identification. durationS(text) gives each
// message's airtime, so the ID can be repeated in time.
export function hamPlan(messages, { callsign, durationS }) {
  const call = String(callsign ?? "").toUpperCase();
  if (!CALLSIGN.test(call)) throw new Error("a valid amateur callsign is required (--ham <CALLSIGN>)");
  for (const m of messages) { const why = hamRefusal(m); if (why) throw new Error(`refused: ${why}`); }
  const id = `DE ${call}`, plan = [id];
  let since = durationS(id);
  for (const m of messages) {
    const d = durationS(m);
    if (since + d > ID_EVERY_S) { plan.push(id); since = durationS(id); }
    plan.push(m); since += d;
  }
  plan.push(id);
  return plan;
}
