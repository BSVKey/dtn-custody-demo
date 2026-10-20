#!/usr/bin/env node
// Run a Bitcoin BSV faucet over sound, radio, SMS or QR.
//
//   plan       node radio/faucet/cli.mjs plan --coin 1000 --count 500        (or --total 500000)
//   build      node radio/faucet/cli.mjs build --key-file faucet.wif --fund-file fund.hex
//                  --coin 1000 --count 500 --dir my-faucet [--mode claims|bearer] [--claim-to +15551234567]
//              builds and signs the fan-out that makes the coins; sends nothing
//   broadcast  node radio/faucet/cli.mjs broadcast --dir my-faucet --spend-real-bsv
//              sends the fan-out to BSV mainnet (ARC); you run this
//   announce   node radio/faucet/cli.mjs announce --dir my-faucet [--key-file faucet.wif]
//                  [--wav out.wav --channel walkie|am|fm|phone|speaker] [--out lines.txt]
//              claims mode: one announcement line. bearer mode: the line plus one line per coin
//              still unclaimed, each holding that coin's key (needs --key-file)
//   serve      node radio/faucet/cli.mjs serve --dir my-faucet --key-file faucet.wif
//                  [Twilio or SMS Gateway for Android options, as radio/sms/server.mjs] [--spend-real-bsv]
//              answers claims by text (claims mode) and relays payments, including swept bearer coins
//   sweep      node radio/faucet/cli.mjs sweep --line "<coin line heard>" --to <your address>
//              signs the coin over to you, offline; prints it as a BSV1 text to forward
//   status     node radio/faucet/cli.mjs status --dir my-faucet
//
// The faucet key file is read, never written or printed. faucet.json holds no secrets.
import { readFileSync, writeFileSync, mkdirSync, existsSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { PrivateKey, Transaction } from "@bsv/sdk";
import { planFaucet, buildFanout, faucetId, coinKey, coinLine, announcement, sweepCoinLine } from "./faucet.mjs";
import { faucetClaims, combineHandlers } from "./claims.mjs";
import { arcBroadcaster, dryRun } from "../lib/gateway.mjs";
import { arcVerdict } from "../../agent/lib/arc.mjs";
import { encodePayment, checkOffline } from "../lib/payment.mjs";
import { paymentTexts } from "../sms/text.mjs";
import { smsGateway } from "../sms/gateway.mjs";
import { smsServer, adaptersFromArgs } from "../sms/server.mjs";
import { CHANNELS } from "../lib/channels.mjs";
import { ggwaveCodec, QUIET } from "../lib/sound.mjs";
import { render } from "../audio/make-wav.mjs";
import { writeWav } from "../audio/wav.mjs";

const ARC = process.env.ARC_URL || "https://arc.gorillapool.io";

// coins used so far, from the claims ledger (no key needed)
export function claimedCount(dir) {
  const f = join(dir, "claims.jsonl");
  return existsSync(f) ? new Set(readFileSync(f, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l).coin)).size : 0;
}

// lines to announce now: claims mode one line; bearer mode the line plus each unclaimed coin
export function announceLines({ config, master, claimed = 0 }) {
  const left = config.count - claimed;
  const head = announcement({ id: config.id, mode: config.mode, coinSats: config.coinSats, left, count: config.count, claimTo: config.claimTo });
  if (config.mode !== "bearer") return [head];
  if (!master) throw new Error("bearer mode announces coin keys: give --key-file");
  return [head, ...Array.from({ length: config.count }, (_, i) => coinLine({ i, key: coinKey(master, config.funding, i), txid: config.fanoutTxid, vout: i, sats: config.coinSats }))];
}

async function main() {
  const [cmd] = process.argv.slice(2);
  const arg = (k) => { const a = process.argv.find((x) => x.startsWith(`--${k}=`)); if (a) return a.slice(k.length + 3); const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : undefined; };
  const has = (k) => process.argv.includes(`--${k}`);
  const read = (k) => readFileSync(arg(k), "utf8").trim();
  const num = (k) => (arg(k) != null ? Number(arg(k)) : undefined);
  const feeRate = num("fee-rate") ?? 100;
  const fail = (m) => { console.error(m); process.exit(2); };
  const dir = arg("dir");
  const loadConfig = () => { if (!dir || !existsSync(join(dir, "faucet.json"))) fail("give --dir of a built faucet"); return JSON.parse(readFileSync(join(dir, "faucet.json"), "utf8")); };
  const masterKey = () => (arg("key-file") ? PrivateKey.fromWif(read("key-file")) : null);

  if (cmd === "plan") {
    let p;
    try { p = planFaucet({ coinSats: num("coin"), count: num("count"), total: num("total"), feeRate }); } catch (e) { fail(e.message); }
    console.log(`${p.count} coins of ${p.coinSats} sat = ${p.coinsTotal} sat, plus a ${p.fanoutFee} sat fee to make them: fund with at least ${p.need} sat`);
    console.log(`each claimant receives ${p.received} sat (claiming costs about ${p.claimFee} sat at ${feeRate} sat/kB)${p.leftover ? `; ${p.leftover} sat of the total is left over` : ""}`);
    return;
  }

  if (cmd === "build") {
    const master = masterKey();
    if (!master || !arg("fund-file") || !dir) fail("usage: build --key-file <faucet.wif> --fund-file <fund.hex> --coin <sat> (--count <n> | --total <sat>) --dir <dir> [--mode claims|bearer] [--claim-to <number>]");
    const mode = arg("mode") ?? "claims";
    if (!["claims", "bearer"].includes(mode)) fail("--mode is claims or bearer");
    const coinSats = num("coin"), count = num("count") ?? (num("total") != null ? Math.floor(num("total") / coinSats) : undefined);
    let built;
    try { built = await buildFanout({ master, fundTx: Transaction.fromHex(read("fund-file")), coinSats, count, feeRate, mode }); } catch (e) { fail(e.message); }
    const { tx, plan, id, funding } = built;
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "fanout.hex"), tx.toHex() + "\n");
    writeFileSync(join(dir, "fanout.ef.hex"), Buffer.from(tx.toEF()).toString("hex") + "\n");
    const config = { id, funding, address: master.toAddress(), mode, coinSats: plan.coinSats, count: plan.count, feeRate, fanoutTxid: tx.id("hex"), claimTo: arg("claim-to") ?? null, built: new Date().toISOString(), broadcast: false };
    writeFileSync(join(dir, "faucet.json"), JSON.stringify(config, null, 2) + "\n");
    console.log(`faucet ${id} (${mode}): ${plan.count} coins of ${plan.coinSats} sat, fan-out ${tx.id("hex")}, fee ${plan.fanoutFee} sat`);
    console.log(`written to ${dir}. Nothing is sent: run "broadcast --dir ${dir} --spend-real-bsv" when ready.`);
    return;
  }

  if (cmd === "broadcast") {
    const config = loadConfig();
    const tx = Transaction.fromHex(readFileSync(join(dir, "fanout.hex"), "utf8").trim());
    const ef = readFileSync(join(dir, "fanout.ef.hex"), "utf8").trim();
    if (!has("spend-real-bsv")) fail(`not sent. This spends real BSV: add --spend-real-bsv to send fan-out ${tx.id("hex")} to mainnet via ${ARC}.`);
    const r = await fetch(`${ARC}/v1/tx`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ rawTx: ef }) });
    const text = await r.text();
    const v = arcVerdict(r.status, text);
    if (!v.ok) fail(`not accepted: ${v.why}`);
    writeFileSync(join(dir, "faucet.json"), JSON.stringify({ ...config, broadcast: new Date().toISOString() }, null, 2) + "\n");
    console.log(`fan-out ${tx.id("hex")} accepted via ${ARC} (${v.txStatus}). The faucet's coins exist now.`);
    return;
  }

  if (cmd === "announce") {
    const config = loadConfig();
    let lines;
    try { lines = announceLines({ config, master: masterKey(), claimed: config.mode === "claims" ? claimedCount(dir) : 0 }); } catch (e) { fail(e.message); }
    if (arg("out")) writeFileSync(arg("out"), lines.join("\n") + "\n");
    if (arg("wav")) {
      const ch = CHANNELS[arg("channel") ?? "speaker"];
      if (!ch) fail(`--channel is one of ${Object.keys(CHANNELS).join(", ")}`);
      const codec = ggwaveCodec(await createRequire(import.meta.url)("ggwave")(QUIET));
      const samples = render(codec, lines, { speed: ch.speed, leadInS: ch.leadInS, repeat: Number(arg("repeat") ?? 1) });
      writeFileSync(arg("wav"), writeWav(samples, codec.sampleRate));
      console.error(`${arg("wav")}: ${lines.length} line(s), ${ch.label}, ${(samples.length / codec.sampleRate / 60).toFixed(1)} min`);
    }
    if (!arg("out") && !arg("wav")) console.log(lines.join("\n"));
    return;
  }

  if (cmd === "serve") {
    const config = loadConfig(), master = masterKey();
    if (!master || faucetId(master, config.funding) !== config.id) fail("--key-file must be this faucet's key");
    const real = has("spend-real-bsv"), broadcast = real ? arcBroadcaster(arg("arc")) : dryRun;
    const ts = () => new Date().toISOString().slice(11, 19);
    const relay = smsGateway({ key: master, broadcast });
    const handlers = config.mode === "claims" ? [faucetClaims({ master, config, dir, broadcast, perSender: num("per-sender") ?? 1, log: (e) => console.log(`${ts()} claim: coin ${e.coin} to ${e.to}, ${e.status}`) }), relay] : [relay];
    const { twilio, android } = adaptersFromArgs(arg, read);
    const port = num("port") ?? 8787;
    smsServer({ gateway: combineHandlers(...handlers), twilio, android }).listen(port, () => {
      console.log(`${ts()} faucet ${config.id} (${config.mode}) on :${port}; receipts signed by ${master.toPublicKey().toString()}`);
      console.log(`${ts()} ${real ? "PAYING ON BSV MAINNET" : "dry run: claims are answered but nothing is sent (add --spend-real-bsv)"}`);
    });
    return;
  }

  if (cmd === "sweep") {
    if (!arg("line") || !arg("to")) fail('usage: sweep --line "<coin line>" --to <your address>');
    let tx;
    try { tx = await sweepCoinLine(arg("line"), arg("to"), feeRate); } catch (e) { fail(e.message); }
    const { type, msg } = encodePayment(tx), c = checkOffline(tx);
    console.log(`swept ${tx.outputs[0].satoshis} sat to ${arg("to")} (fee ${c.fee} sat), txid ${tx.id("hex")}`);
    console.log("not sent yet. Forward this by text to an SMS gateway, or paste it into the phone page:");
    console.log(paymentTexts(type, msg)[0]);
    return;
  }

  if (cmd === "status") {
    const config = loadConfig();
    const used = claimedCount(dir);
    console.log(`faucet ${config.id} (${config.mode}): ${config.count} coins of ${config.coinSats} sat; fan-out ${config.fanoutTxid} ${config.broadcast ? `sent ${config.broadcast}` : "NOT sent yet"}`);
    if (config.mode === "claims") console.log(`${used} coin(s) paid out, ${config.count - used} left`);
    return;
  }

  fail("commands: plan, build, broadcast, announce, serve, sweep, status (see the top of radio/faucet/cli.mjs)");
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) await main();
