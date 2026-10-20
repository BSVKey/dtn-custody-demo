#!/usr/bin/env node
// SMS gateway server. Two ways for texts to reach it:
//
//   POST /twilio    Twilio's incoming-message webhook. The X-Twilio-Signature header is checked
//                   against your auth token and the public URL Twilio calls; the receipt goes back
//                   as a TwiML <Message> reply.
//   POST /android   the "sms:received" webhook of SMS Gateway for Android (open source,
//                   github.com/capcom6/android-sms-gateway): any spare Android phone with a SIM
//                   becomes the gateway's number. X-Signature (HMAC-SHA256 of body + X-Timestamp)
//                   is checked, and the receipt is sent back through the phone's local API.
//
//   node radio/sms/server.mjs --key-file gateway.wif [--port 8787]
//       [--twilio-token-file twilio.token --public-url https://example.org/twilio]
//       [--android-key-file signing.key --android-device http://192.168.1.20:8080
//        --android-user sms --android-pass-file android.pass]
//       [--spend-real-bsv [--arc https://arc.gorillapool.io]]
//
// Dry run unless --spend-real-bsv. Secrets come from files and are never printed. Not yet run
// against a live Twilio account or a phone running the app.
import http from "node:http";
import { createHmac, timingSafeEqual } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { PrivateKey } from "@bsv/sdk";
import { smsGateway } from "./gateway.mjs";
import { arcBroadcaster, dryRun } from "../lib/gateway.mjs";

const same = (a, b) => { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && timingSafeEqual(x, y); };

// Twilio: base64 HMAC-SHA1 over the full URL followed by each POST parameter name and value,
// sorted by name.
export function twilioSignature(authToken, url, params) {
  const data = url + Object.keys(params).sort().map((k) => k + params[k]).join("");
  return createHmac("sha1", authToken).update(data, "utf8").digest("base64");
}

// SMS Gateway for Android: hex HMAC-SHA256 over the raw body followed by X-Timestamp.
export function androidSignature(signingKey, rawBody, timestamp) {
  return createHmac("sha256", signingKey).update(rawBody + timestamp, "utf8").digest("hex");
}

export function androidSender({ device, user, pass }) {
  return async (to, text) => {
    const r = await fetch(`${device.replace(/\/$/, "")}/message`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Basic ${Buffer.from(`${user}:${pass}`).toString("base64")}` },
      body: JSON.stringify({ textMessage: { text }, phoneNumbers: [to] }),
    });
    if (!r.ok) throw new Error(`phone refused the reply: ${r.status}`);
  };
}

// --twilio-token-file + --public-url and/or --android-key-file + --android-device/-user/-pass-file
export function adaptersFromArgs(arg, read) {
  const twilio = arg("twilio-token-file") ? { authToken: read("twilio-token-file"), publicUrl: arg("public-url") } : null;
  if (twilio && !twilio.publicUrl) { console.error("--public-url (the exact URL Twilio calls) is needed to check Twilio signatures"); process.exit(2); }
  const android = arg("android-key-file") ? { signingKey: read("android-key-file"), send: androidSender({ device: arg("android-device"), user: arg("android-user"), pass: read("android-pass-file") }) } : null;
  if (!twilio && !android) { console.error("give --twilio-token-file and/or --android-key-file"); process.exit(2); }
  return { twilio, android };
}

const xml = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export function smsServer({ gateway, twilio, android, maxSkewS = 300, log = () => {} }) {
  return http.createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const raw = Buffer.concat(chunks).toString("utf8");
    const end = (code, body = "", type = "text/plain") => { res.writeHead(code, { "content-type": type }); res.end(body); };
    try {
      if (req.method === "POST" && req.url.split("?")[0] === "/twilio" && twilio) {
        const params = Object.fromEntries(new URLSearchParams(raw));
        if (!same(req.headers["x-twilio-signature"] ?? "", twilioSignature(twilio.authToken, twilio.publicUrl, params))) { log({ ev: "bad-signature", via: "twilio" }); return end(403, "bad signature"); }
        const reply = await gateway.handle(params.From, params.Body);
        return end(200, `<?xml version="1.0" encoding="UTF-8"?><Response>${reply ? `<Message>${xml(reply)}</Message>` : ""}</Response>`, "text/xml");
      }
      if (req.method === "POST" && req.url.split("?")[0] === "/android" && android) {
        const ts = req.headers["x-timestamp"] ?? "";
        if (!same(req.headers["x-signature"] ?? "", androidSignature(android.signingKey, raw, ts))) { log({ ev: "bad-signature", via: "android" }); return end(403, "bad signature"); }
        if (!(Math.abs(Date.now() / 1000 - Number(ts)) <= maxSkewS)) { log({ ev: "stale", via: "android" }); return end(403, "stale timestamp"); }
        const ev = JSON.parse(raw);
        if (ev.event !== "sms:received") return end(200, "ignored");
        const from = ev.payload?.sender ?? ev.payload?.phoneNumber;
        const reply = await gateway.handle(from, ev.payload?.message);
        if (reply) await android.send(from, reply);
        return end(200, "ok");
      }
      end(404, "not found");
    } catch (e) {
      log({ ev: "error", detail: e.message });
      end(500, "error");
    }
  });
}

async function main() {
  const arg = (k) => { const a = process.argv.find((x) => x.startsWith(`--${k}=`)); if (a) return a.slice(k.length + 3); const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : undefined; };
  const has = (k) => process.argv.includes(`--${k}`);
  const read = (k) => readFileSync(arg(k), "utf8").trim();
  if (!arg("key-file")) { console.error("usage: node radio/sms/server.mjs --key-file <gateway.wif> [--twilio-token-file ... --public-url ...] [--android-key-file ... --android-device ... --android-user ... --android-pass-file ...] [--spend-real-bsv]"); process.exit(2); }
  const key = PrivateKey.fromWif(read("key-file"));
  const real = has("spend-real-bsv");
  const ts = () => new Date().toISOString().slice(11, 19);
  const gateway = smsGateway({ key, broadcast: real ? arcBroadcaster(arg("arc")) : dryRun, log: (e) => {
    if (e.ev === "payment") console.log(`${ts()} payment ${e.txid} from ${e.from}: status ${e.status}${e.detail ? ` (${e.detail})` : ""}`);
    else if (e.ev !== "ignored") console.log(`${ts()} ${e.ev} ${e.id ?? ""} ${e.part ? `${e.part}/${e.of}` : ""}`);
  } });
  const { twilio, android } = adaptersFromArgs(arg, read);
  const port = Number(arg("port") ?? 8787);
  smsServer({ gateway, twilio, android, log: (e) => console.log(`${ts()} ${e.ev} ${e.via ?? e.detail ?? ""}`) }).listen(port, () => {
    console.log(`${ts()} SMS gateway on :${port} (${[twilio && "/twilio", android && "/android"].filter(Boolean).join(", ")}); receipt key ${key.toPublicKey().toString()}`);
    console.log(`${ts()} ${real ? "BROADCASTING valid payments on BSV MAINNET" : "dry run: payments are checked, never broadcast (add --spend-real-bsv to send)"}`);
  });
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) await main();
