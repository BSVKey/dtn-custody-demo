// Records the demo as a standard asciinema v2 cast (demo/dtn.cast) by running the REAL
// commands and capturing their real output with real timing. Idle gaps are capped so
// waits don't drag; the R2 contact-gap hold is kept visibly longer on purpose.
//
// Usage (from the repo root, Docker running): node demo/record.mjs
// The r2 image is pre-built so the cast shows the run, not a Docker build.
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";

const W = 110, H = 30;
const AMBER = "\x1b[38;5;214m", DIM = "\x1b[90m", RST = "\x1b[0m", CLR = "\x1b[2J\x1b[H";

const steps = [
  { cap: "1/5  acceptance suite: offline, deterministic", show: "npm test", run: "npm test", idle: 0.6 },
  { cap: "2/5  full pipeline over the simulator: chunk > Merkle > occultation gap > verify > settle", show: "npm run demo", run: "npm run demo", idle: 0.6 },
  { cap: "3/5  real Linux netem links (150ms + reorder), then a real 100%-loss blackout: the payload survives", show: "make spike",
    run: "docker run --rm --privileged dtn-custody-m0", idle: 2.0 },
  { cap: "4/5  same custody chain over real Bundle Protocol v7 (uD3TN), held across a real contact gap", show: "make r2",
    run: "docker run --rm dtn-custody-r2 bash /app/r2/run-r2.sh", idle: 3.0 },
  { cap: "5/5  delivery bound to a real on-chain BSV settlement + provenance anchor", show: "make live", run: "node live/run-live.mjs", idle: 0.6 },
];

const events = [];
let t = 0;
const out = (s) => events.push([+t.toFixed(3), "o", s]);
const wait = (s) => { t += s; };
const crlf = (s) => s.replace(/\r?\n/g, "\r\n");

function type(cmd) {
  out(`${AMBER}$${RST} `);
  for (const ch of cmd) { wait(0.045 + Math.random() * 0.04); out(ch); }
  wait(0.35); out("\r\n");
}

function runStep(cmd, maxIdle) {
  return new Promise((resolve) => {
    const env = { ...process.env, FORCE_COLOR: "1", MSYS_NO_PATHCONV: "1", LIVE: "" };
    const p = spawn(cmd, { shell: true, env });
    let last = Date.now();
    const onData = (d) => {
      const now = Date.now();
      wait(Math.min((now - last) / 1000, maxIdle));
      last = now;
      out(crlf(d.toString("utf8")));
    };
    p.stdout.on("data", onData);
    p.stderr.on("data", onData);
    p.on("close", (code) => resolve(code));
  });
}

for (const s of steps) {
  out(CLR);
  out(`${DIM}# ${s.cap}${RST}\r\n`);
  wait(0.9);
  type(s.show);
  const code = await runStep(s.run, s.idle);
  if (code !== 0) console.error(`step "${s.show}" exited ${code}`);
  wait(4.0);
}
out(CLR);
out(`${DIM}# the manifest root, anchored on chain (OP_RETURN):${RST}\r\n`);
out(`${AMBER}https://whatsonchain.com/tx/d49777e46abe6dfa02586d3ab81f91c52fb9026dd667d6adafd848fa8889e8ca${RST}\r\n\r\n`);
out(`Verifiable data custody + relay settlement over DTN. Apache-2.0.\r\n`);
out(`${AMBER}github.com/BSVKey/dtn-custody-demo${RST}  ·  ${AMBER}dtn.bsvkey.com${RST}\r\n`);
wait(5);
out("");

const header = { version: 2, width: W, height: H, timestamp: Math.floor(Date.now() / 1000),
  title: "dtn-custody-demo: verifiable data custody + relay settlement over DTN",
  env: { SHELL: "/bin/bash", TERM: "xterm-256color" } };
writeFileSync(new URL("./dtn.cast", import.meta.url),
  [JSON.stringify(header), ...events.map((e) => JSON.stringify(e))].join("\n") + "\n");
console.log(`wrote demo/dtn.cast: ${events.length} events, ${t.toFixed(1)}s`);
