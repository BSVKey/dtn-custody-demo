// Gateway interop with NASA HDTN, run inside the dtn-custody-hdtn image:
//
//   docker run --rm -v "<repo>:/app" -w /app dtn-custody-hdtn node gateway/hdtn-interop.mjs
//
// UDP frames -> gateway A (ipn:1) -TCPCLv4-> HDTN (ipn:10, stock config: ingress 4556,
// egress 4558) -TCPCLv4-> gateway B (ipn:2, listening on 4558) -> UDP sink.
// Phase 1 sends 10 frames with everything up. Phase 2 kills HDTN (the relay link is gone),
// sends 10 more frames while it is down, then starts HDTN again. Every frame must reach
// the sink once, in order, with a valid ingress receipt from gateway A.
//
// With --tls both TCPCLv4 links run over TLS 1.3: gateway A checks that HDTN's certificate
// names ipn:10.0, and HDTN checks that gateway B's certificate names ipn:2.0, all signed by
// a test CA made at the start of the run.
import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import dgram from "node:dgram";
import { Gateway } from "./gateway.mjs";
import { genKeypair } from "../agent/lib/keys.mjs";
import { makeCerts, selfSigned } from "./certs.mjs";

const H = process.env.HDTN_SOURCE_ROOT || "/opt/HDTN";
const BIN = `${H}/build/module/hdtn_one_process/hdtn-one-process`;
const TLS = process.argv.includes("--tls");
const STOCK = `${H}/config_files/hdtn/hdtn_ingress1tcpclv4_port4556_egress1tcpclv4_port4558flowid2.json`;
let CFG = STOCK, pki = null;
if (TLS) {
  const dir = mkdtempSync(join(tmpdir(), "pki-"));
  pki = makeCerts(dir, ["ipn:1.0", "ipn:10.0"]);
  // HDTN's outduct checks the Node ID on every certificate in the chain, the CA included,
  // so the HDTN -> gateway B hop pins gateway B's own self-signed certificate, the same
  // form HDTN's shipped TLS configs use. Gateway A -> HDTN uses the CA chain.
  pki["ipn:2.0"] = selfSigned(dir, "ipn:2.0");
  const c = JSON.parse(readFileSync(STOCK, "utf8"));
  Object.assign(c.inductsConfig.inductVector[0], {
    tlsIsRequired: true, certificatePemFile: `${dir}/ipn_10.0.crt`, privateKeyPemFile: `${dir}/ipn_10.0.key`, diffieHellmanParametersPemFile: "",
  });
  Object.assign(c.outductsConfig.outductVector[0], {
    tryUseTls: true, tlsIsRequired: true, useTlsVersion1_3: true, doX509CertificateVerification: true,
    verifySubjectAltNameInX509Certificate: true, certificationAuthorityPemFileForVerification: pki["ipn:2.0"].certFile,
  });
  CFG = `${dir}/hdtn-tls.json`;
  writeFileSync(CFG, JSON.stringify(c, null, 2));
}
const tlsFor = (id, extra) => (TLS ? { tls: { key: pki[id].key, cert: pki[id].cert, ca: pki.ca, require: true, minVersion: "TLSv1.3", ...extra } } : {});
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms) => { const end = Date.now() + ms; while (Date.now() < end) { if (fn()) return true; await wait(100); } return false; };

execFileSync("node", ["contact-plans/compile.mjs", "gateway/hdtn-plan.json", "--hdtn", `${H}/module/router/contact_plans/gatewayInterop.json`], { stdio: "inherit" });

let hdtn = null;
function startHdtn() {
  const log = join(tmpdir(), `hdtn-${Date.now()}.log`);
  hdtn = spawn(BIN, ["--contact-plan-file=gatewayInterop.json", `--hdtn-config-file=${CFG}`], { cwd: tmpdir(), stdio: ["ignore", "pipe", "pipe"] });
  const out = [];
  hdtn.stdout.on("data", (d) => { out.push(d); if (process.env.HDTN_LOG) process.stdout.write(d); });
  hdtn.stderr.on("data", (d) => { out.push(d); if (process.env.HDTN_LOG) process.stdout.write(d); });
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
  // HDTN's outduct presents no client certificate, so gateway B serves TLS without asking for one.
  ...tlsFor("ipn:2.0", { ca: undefined }),
  ipEgress: { 1: { udp: "127.0.0.1:9101" } }, pinnedGateways: { "ipn:1.0": kp.pub }, requireIngressReceipt: true, log: log("gwB"),
}).start();
gwB.on("delivered", (d) => receipts.push(d.ingress));
let tlsSessionsIn = 0;
gwB.on("session-in", (p) => { if (p.tls) tlsSessionsIn++; });

startHdtn();
await wait(4000);
const gwA = await new Gateway({
  node: 1, spoolDir: mkdtempSync(join(tmpdir(), "gwA-")), keypair: kp, peer: { host: "127.0.0.1", port: 4556 },
  ...tlsFor("ipn:1.0", { verifyNodeId: true }),
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
  path: `UDP -> gateway A ipn:1 -TCPCLv4${TLS ? "+TLS" : ""}-> NASA HDTN ipn:10 -TCPCLv4${TLS ? "+TLS" : ""}-> gateway B ipn:2 -> UDP`,
  tls: TLS, gatewayAPeerTls: TLS ? gwA.session?.peer?.tls ?? null : false,
  delivered: got.length, expected: expected.length, inOrder: JSON.stringify(got) === JSON.stringify(expected),
  ingressReceiptsValid: receipts.filter((r) => r && r.ok).length,
  spooledDuringOutage,
  gatewayA: gwA.stats, gatewayB: gwB.stats,
};
if (TLS) result.ok = result.ok && result.gatewayAPeerTls === true && tlsSessionsIn > 0;
result.tlsSessionsIntoB = tlsSessionsIn;
console.log(`GATEWAY_HDTN_RESULT ${JSON.stringify(result)}`);
if (!result.ok && hdtn) console.log(Buffer.concat(hdtn.out).toString().split("\n").slice(-30).join("\n"));
await gwA.stop(); await gwB.stop(); await stopHdtn(); sink.close();
process.exit(result.ok ? 0 : 1);
