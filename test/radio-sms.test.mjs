// Payments by SMS (radio/sms/), offline: GSM-7-safe texts, parts for short satellite texts, the
// gateway's signed receipt reply, and both webhooks (Twilio, SMS Gateway for Android) over a real
// local HTTP server with simulated requests. Synthetic funding; nothing is broadcast.
import { test } from "node:test";
import assert from "node:assert/strict";
import { PrivateKey } from "@bsv/sdk";
import { TYPE } from "../radio/lib/frame.mjs";
import { encodePayment, decodePayment } from "../radio/lib/payment.mjs";
import { paymentTexts, parseText, textAssembler, readReceiptText } from "../radio/sms/text.mjs";
import { smsGateway } from "../radio/sms/gateway.mjs";
import { smsServer, twilioSignature, androidSignature } from "../radio/sms/server.mjs";
import { demoPayment } from "../radio/run-demo.mjs";

const GSM7_SAFE = /^[A-Za-z0-9+/= \n]*$/;

test("twilio signature matches Twilio's documented example", () => {
  const sig = twilioSignature("12345", "https://mycompany.com/myapp.php?foo=1&bar=2", { CallSid: "CA1234567890ABCDE", Caller: "+12349013030", Digits: "1234", From: "+12349013030", To: "+18005551212" });
  assert.equal(sig, "0/KCTR6DLpKmkAf8muzZqo1nDgQ=");
});

test("texts: one GSM-7-safe text, or parts under a length limit, in any order", async () => {
  const { tx } = await demoPayment();
  const { type, msg } = encodePayment(tx);
  const [one] = paymentTexts(type, msg);
  assert.ok(GSM7_SAFE.test(one));
  assert.ok(one.length < 400);
  assert.deepEqual(parseText(`  ${one.replace(" ", "\n")} `).msg, msg); // phones add whitespace

  const parts = paymentTexts(type, msg, { maxChars: 120 });
  assert.ok(parts.length > 3 && parts.every((t) => t.length <= 120 && GSM7_SAFE.test(t)));
  const a = textAssembler();
  let whole = null;
  for (const t of [...parts].reverse()) whole = a.add("+15550001", parseText(t)) ?? whole;
  assert.deepEqual(whole.msg, msg);
  assert.equal(decodePayment(whole.type, whole.msg).id("hex"), tx.id("hex"));

  // parts from two senders never mix, and a bad part is caught by the hash
  const b = textAssembler();
  b.add("+1A", parseText(parts[0]));
  assert.equal(b.add("+1B", parseText(parts[1])), null);
  const bad = parts.map((t, i) => (i === 1 ? t.slice(0, -4) + (t.slice(-4) === "AAAA" ? "BBBB" : "AAAA") : t));
  const c = textAssembler();
  let r = null;
  for (const t of bad) r = c.add("+1C", parseText(t)) ?? r;
  assert.equal(r.corrupt, true);
  assert.equal(parseText("hi, are you there?"), null);
});

test("gateway: replies with a signed receipt; a repeat gets the same reply; bad payments are rejected", async () => {
  const key = PrivateKey.fromRandom(), pin = key.toPublicKey().toString();
  let calls = 0;
  const gw = smsGateway({ key, broadcast: async () => { calls++; return { ok: true, sent: true, detail: "test" }; } });
  const { tx } = await demoPayment();
  const { type, msg } = encodePayment(tx);
  const [text] = paymentTexts(type, msg);
  const reply = await gw.handle("+15550001", text);
  assert.match(reply, /^BSV RECEIPT ACCEPTED [0-9a-f]{64}\nR1 /);
  assert.ok(GSM7_SAFE.test(reply));
  const r = readReceiptText(reply, pin);
  assert.equal(r.txid, tx.id("hex"));
  assert.equal(r.status, "ACCEPTED");
  assert.equal(readReceiptText(reply, PrivateKey.fromRandom().toPublicKey().toString()), null);
  assert.equal(await gw.handle("+15550001", text), reply);
  assert.equal(calls, 1);

  const bad = decodePayment(TYPE.PAY_EF, msg);
  bad.outputs[0].satoshis += 1;
  const badReply = await gw.handle("+15550002", paymentTexts(TYPE.PAY_EF, Buffer.from(bad.toEF()))[0]);
  assert.match(badReply, /^BSV RECEIPT REJECTED/);
  assert.match(badReply, /why: /);
  assert.equal(calls, 1);
  assert.equal(await gw.handle("+15550003", "STOP"), null);

  const dry = smsGateway({ key });
  assert.match(await dry.handle("+1", text), /^BSV RECEIPT VALID_NOT_SENT/);
});

async function serve(opts) {
  const server = smsServer(opts);
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return { url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((r) => server.close(r)) };
}

test("twilio webhook: a signed request gets a TwiML receipt; a forged one is refused", async () => {
  const key = PrivateKey.fromRandom();
  const twilio = { authToken: "test-token", publicUrl: "https://gw.example.org/twilio" };
  const s = await serve({ gateway: smsGateway({ key }), twilio });
  try {
    const { tx } = await demoPayment();
    const { type, msg } = encodePayment(tx);
    const params = { From: "+15550001", To: "+15559999", Body: paymentTexts(type, msg)[0], MessageSid: "SM123" };
    const post = (sig) => fetch(`${s.url}/twilio`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", "x-twilio-signature": sig }, body: new URLSearchParams(params).toString() });
    const ok = await post(twilioSignature(twilio.authToken, twilio.publicUrl, params));
    assert.equal(ok.status, 200);
    const body = await ok.text();
    assert.match(body, /<Response><Message>BSV RECEIPT VALID_NOT_SENT /);
    const inner = body.match(/<Message>([\s\S]*)<\/Message>/)[1];
    assert.equal(readReceiptText(inner, key.toPublicKey().toString()).txid, tx.id("hex"));
    assert.equal((await post("forged")).status, 403);
  } finally { await s.close(); }
});

test("android webhook: a signed sms:received event is answered through the phone; bad or stale signatures are refused", async () => {
  const key = PrivateKey.fromRandom(), sent = [];
  const android = { signingKey: "phone-signing-key", send: async (to, text) => { sent.push({ to, text }); } };
  const s = await serve({ gateway: smsGateway({ key }), android });
  try {
    const { tx } = await demoPayment();
    const { type, msg } = encodePayment(tx);
    const event = (message) => JSON.stringify({ deviceId: "dev1", event: "sms:received", id: "ev1", webhookId: "wh1", payload: { messageId: "m1", message, sender: "+15550001", recipient: "+15559999", simNumber: 1, receivedAt: new Date().toISOString() } });
    const post = (raw, ts = String(Math.floor(Date.now() / 1000)), sig = androidSignature(android.signingKey, raw, ts)) =>
      fetch(`${s.url}/android`, { method: "POST", headers: { "content-type": "application/json", "x-signature": sig, "x-timestamp": ts }, body: raw });

    for (const part of paymentTexts(type, msg, { maxChars: 160 })) assert.equal((await post(event(part))).status, 200);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].to, "+15550001");
    assert.equal(readReceiptText(sent[0].text, key.toPublicKey().toString()).txid, tx.id("hex"));

    const raw = event(paymentTexts(type, msg)[0]);
    assert.equal((await post(raw, undefined, "00".repeat(32))).status, 403);
    const old = String(Math.floor(Date.now() / 1000) - 3600);
    assert.equal((await post(raw, old)).status, 403);
  } finally { await s.close(); }
});
