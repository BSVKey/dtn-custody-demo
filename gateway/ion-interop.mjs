// Gateway interop with JPL ION over TCPCLv3 (RFC 7242), run inside the ion/Dockerfile image:
//
//   docker run --rm --privileged -v "<repo>:/app" -w /app dtn-custody-ion node gateway/ion-interop.mjs
//
// UDP frames -> gateway A (ipn:1) -TCPCLv3-> ION node ipn:10 (tcpcli on 4556, contact graph
// routing, tcpclo to 4558) -TCPCLv3-> gateway B (ipn:2) -> UDP sink. ION runs in its own IPC
// namespace (its state lives in SysV shared memory). Phase 1 sends 10 frames; phase 2 kills
// the ION node, sends 10 more while it is gone, and starts ION again. Every frame must
// arrive once, in order, with a valid ingress receipt from gateway A.
import { spawn, execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import dgram from "node:dgram";
import { Gateway } from "./gateway.mjs";
import { genKeypair } from "../agent/lib/keys.mjs";

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms) => { const end = Date.now() + ms; while (Date.now() < end) { if (fn()) return true; await wait(100); } return false; };
const D = "/tmp/ion10";
mkdirSync(D, { recursive: true });
writeFileSync(`${D}/node.ionconfig`, `configFlags 1\nwmSize 5000000\nheapWords 2500000\npathName ${D}\n`);
const contacts = [[1, 10], [10, 1], [10, 2], [2, 10], [10, 10]];
writeFileSync(`${D}/node.rc`, [
  "## begin ionadmin", `1 10 ${D}/node.ionconfig`, "s",
  ...contacts.map(([a, b]) => `a contact +0 +3600 ${a} ${b} 12500000`),
  ...contacts.map(([a, b]) => `a range +0 +3600 ${a} ${b} 0`),
  "m horizon +0", "## end ionadmin",
  "## begin bpadmin", "1", "a scheme ipn 'ipnfw' 'ipnadminep'", "a endpoint ipn:10.1 q",
  "a protocol tcp", "a induct tcp 127.0.0.1:4556 tcpcli", "a outduct tcp 127.0.0.1:4558 tcpclo", "s", "## end bpadmin",
  "## begin ipnadmin", "a plan 2 tcp/127.0.0.1:4558", "## end ipnadmin", "",
].join("\n"));

let ion = null;
function startIon() {
  ion = spawn("unshare", ["--ipc", "--mount", "--fork", "bash", "-c",
    `mount -t tmpfs tmpfs /dev/shm && cd ${D} && ionstart -I node.rc >${D}/start.log 2>&1 && exec sleep infinity`], { detached: true, stdio: "ignore" });
}
async function stopIon() {
  if (!ion) return;
  try { process.kill(-ion.pid, "SIGKILL"); } catch {}
  ion = null;
  await wait(1500);
}

const got = [];
const sink = dgram.createSocket("udp4");
sink.on("message", (m) => got.push(m.toString()));
await new Promise((r) => sink.bind(9101, "127.0.0.1", r));
const send = (s) => new Promise((r) => { const c = dgram.createSocket("udp4"); c.send(Buffer.from(s), 9100, "127.0.0.1", () => { c.close(); r(); }); });

const kp = genKeypair();
const receipts = [];
const log = (who) => (m) => console.log(`[${who}] ${m}`);
const gwB = await new Gateway({
  node: 2, spoolDir: mkdtempSync(join(tmpdir(), "gwB-")), listenPort: 4558, listenCl: "tcpclv3",
  ipEgress: { 1: { udp: "127.0.0.1:9101" } }, pinnedGateways: { "ipn:1.0": kp.pub }, requireIngressReceipt: true, log: log("gwB"),
}).start();
gwB.on("delivered", (d) => receipts.push(d.ingress));

startIon();
await wait(6000);
const gwA = await new Gateway({
  node: 1, spoolDir: mkdtempSync(join(tmpdir(), "gwA-")), keypair: kp, peer: { host: "127.0.0.1", port: 4556, cl: "tcpclv3" },
  retryMs: 500, maxRetryMs: 2000, ipIngress: { udp: [{ port: 9100, dest: "ipn:2.1" }] }, log: log("gwA"),
}).start();

const expected = [];
for (let i = 0; i < 10; i++) { const f = `phase1 frame ${i}`; expected.push(f); await send(f); }
const p1 = await until(() => got.length === 10, 45000);
console.log(`[test] phase 1: ${got.length}/10 frames through ION`);

console.log("[test] killing the ION node");
await stopIon();
for (let i = 0; i < 10; i++) { const f = `outage frame ${i}`; expected.push(f); await send(f); }
await wait(2000);
const spooledDuringOutage = gwA.spool.size;
console.log(`[test] gateway A is holding ${spooledDuringOutage} bundles on disk`);
console.log("[test] restarting ION");
startIon();
const p2 = await until(() => got.length === 20, 90000);
console.log(`[test] phase 2: ${got.length}/20 frames delivered`);

const commit = (() => { try { return readFileSync("/opt/ion/COMMIT", "utf8").trim(); } catch { return "unknown"; } })();
const inOrder = JSON.stringify(got) === JSON.stringify(expected);
const result = {
  ok: p1 && p2 && inOrder && receipts.length === 20 && receipts.every((r) => r && r.ok) && spooledDuringOutage > 0,
  ionCommit: commit,
  path: "UDP -> gateway A ipn:1 -TCPCLv3-> JPL ION ipn:10 -TCPCLv3-> gateway B ipn:2 -> UDP",
  delivered: got.length, expected: expected.length, inOrder,
  ingressReceiptsValid: receipts.filter((r) => r && r.ok).length, spooledDuringOutage,
  gatewayA: gwA.stats, gatewayB: gwB.stats,
};
console.log(`GATEWAY_ION_RESULT ${JSON.stringify(result)}`);
if (!result.ok) { try { console.log(execFileSync("bash", ["-c", `tail -30 ${D}/ion.log; tail -10 ${D}/start.log`]).toString()); } catch {} }
await gwA.stop(); await gwB.stop(); await stopIon(); sink.close();
process.exit(result.ok ? 0 : 1);
