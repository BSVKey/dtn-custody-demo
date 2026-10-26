// Gateway interop with NASA HDTN, run inside the dtn-custody-hdtn image:
//
//   docker run --rm -v "<repo>:/app" -w /app dtn-custody-hdtn node gateway/hdtn-interop.mjs
//
// UDP frames -> gateway A (ipn:1) -TCPCLv4-> HDTN (ipn:10, stock config: ingress 4556,
// egress 4558) -TCPCLv4-> gateway B (ipn:2, listening on 4558) -> UDP sink.
// Phase 1 sends 10 frames with everything up. Phase 2 kills HDTN (the relay link is gone),
// sends 10 more frames while it is down, then starts HDTN again. Every frame must reach
// the sink once, in order, with a valid ingress receipt from gateway A.
import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import dgram from "node:dgram";
import { Gateway } from "./gateway.mjs";
import { genKeypair } from "../agent/lib/keys.mjs";

const H = process.env.HDTN_SOURCE_ROOT || "/opt/HDTN";
const BIN = `${H}/build/module/hdtn_one_process/hdtn-one-process`;
const CFG = `${H}/config_files/hdtn/hdtn_ingress1tcpclv4_port4556_egress1tcpclv4_port4558flowid2.json`;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms) => { const end = Date.now() + ms; while (Date.now() < end) { if (fn()) return true; await wait(100); } return false; };

execFileSync("node", ["contact-plans/compile.mjs", "gateway/hdtn-plan.json", "--hdtn", `${H}/module/router/contact_plans/gatewayInterop.json`], { stdio: "inherit" });

let hdtn = null;
function startHdtn() {
  const log = join(tmpdir(), `hdtn-${Date.now()}.log`);
  hdtn = spawn(BIN, ["--contact-plan-file=gatewayInterop.json", `--hdtn-config-file=${CFG}`], { cwd: tmpdir(), stdio: ["ignore", "pipe", "pipe"] });
  const out = [];
  hdtn.stdout.on("data", (d) => out.push(d));
  hdtn.stderr.on("data", (d) => out.push(d));
  hdtn.on("exit", () => writeFileSync(log, Buffer.concat(out)));
  hdtn.logFile = log;
  hdtn.out = out;
}
async function stopHdtn() {
  if (!hdtn) return;
  const p = hdtn; hdtn = null;
  const gone = new Promise((r) => p.on("exit", r));
  p.kill("SIGINT");
  await Promise.race([gone, wait(5000)]);
  try { p.kill("SIGKILL"); } catch {}
}

const got = [];
const sink = dgram.createSocket("udp4");
sink.on("message", (m) => got.push(m.toString()));
await new Promise((r) => sink.bind(9101, "127.0.0.1", r));
const send = (port, s) => new Promise((r) => { const c = dgram.createSocket("udp4"); c.send(Buffer.from(s), port, "127.0.0.1", () => { c.close(); r(); }); });

const kp = genKeypair();
const receipts = [];
const log = (who) => (m) => console.log(`[${who}] ${m}`);
const gwB = await new Gateway({
  node: 2, spoolDir: mkdtempSync(join(tmpdir(), "gwB-")), listenPort: 4558,
  ipEgress: { 1: { udp: "127.0.0.1:9101" } }, pinnedGateways: { "ipn:1.0": kp.pub }, requireIngressReceipt: true, log: log("gwB"),
}).start();
gwB.on("delivered", (d) => receipts.push(d.ingress));

startHdtn();
await wait(4000);
const gwA = await new Gateway({
  node: 1, spoolDir: mkdtempSync(join(tmpdir(), "gwA-")), keypair: kp, peer: { host: "127.0.0.1", port: 4556 },
  retryMs: 500, maxRetryMs: 2000, ipIngress: { udp: [{ port: 9100, dest: "ipn:2.1" }] }, log: log("gwA"),
}).start();

const expected = [];
for (let i = 0; i < 10; i++) { const f = `phase1 frame ${i}`; expected.push(f); await send(9100, f); }
const p1 = await until(() => got.length === 10, 30000);
console.log(`[test] phase 1: ${got.length}/10 frames through HDTN`);

console.log("[test] killing HDTN: the relay link is down");
await stopHdtn();
for (let i = 0; i < 10; i++) { const f = `outage frame ${i}`; expected.push(f); await send(9100, f); }
await wait(2000);
const spooledDuringOutage = gwA.spool.size;
console.log(`[test] gateway A is holding ${spooledDuringOutage} bundles on disk`);
console.log("[test] restarting HDTN");
startHdtn();
const p2 = await until(() => got.length === 20, 60000);
console.log(`[test] phase 2: ${got.length}/20 frames delivered`);

const commit = (() => { try { return readFileSync(`${H}/COMMIT`, "utf8").trim(); } catch { return "unknown"; } })();
const result = {
  ok: p1 && p2 && JSON.stringify(got) === JSON.stringify(expected) && receipts.length === 20 && receipts.every((r) => r && r.ok) && spooledDuringOutage > 0,
  hdtnCommit: commit,
  path: "UDP -> gateway A ipn:1 -TCPCLv4-> NASA HDTN ipn:10 -TCPCLv4-> gateway B ipn:2 -> UDP",
  delivered: got.length, expected: expected.length, inOrder: JSON.stringify(got) === JSON.stringify(expected),
  ingressReceiptsValid: receipts.filter((r) => r && r.ok).length,
  spooledDuringOutage,
  gatewayA: gwA.stats, gatewayB: gwB.stats,
};
console.log(`GATEWAY_HDTN_RESULT ${JSON.stringify(result)}`);
if (!result.ok && hdtn) console.log(Buffer.concat(hdtn.out).toString().split("\n").slice(-30).join("\n"));
await gwA.stop(); await gwB.stop(); await stopHdtn(); sink.close();
process.exit(result.ok ? 0 : 1);
