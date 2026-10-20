// A real radio endpoint: a Meshtastic device on USB, through radio/meshtastic/bridge.py.
// Same shape as the simulated link's ends: { send(frame), onFrame(cb), close(), ready }.
// Not yet run against real hardware.
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

const BRIDGE = fileURLToPath(new URL("./meshtastic/bridge.py", import.meta.url));

export function meshtasticRadio({ port, dest, channel, python = process.platform === "win32" ? "python" : "python3", gapMs = 0, log = () => {} } = {}) {
  const args = [BRIDGE];
  if (port) args.push("--port", port);
  if (dest) args.push("--dest", dest);
  if (channel != null) args.push("--channel", String(channel));
  const child = spawn(python, args, { stdio: ["pipe", "pipe", "inherit"] });
  const handlers = [];
  let up;
  const ready = new Promise((res, rej) => { up = res; child.once("exit", (c) => rej(new Error(`meshtastic bridge exited (${c}); is 'pip install meshtastic' done and the radio plugged in?`))); });
  createInterface({ input: child.stdout }).on("line", (line) => {
    if (line.startsWith("UP ")) { log({ ev: "radio-up", node: line.slice(3) }); up(line.slice(3)); }
    else if (line.startsWith("RX ")) { const f = Buffer.from(line.slice(3).trim(), "hex"); for (const h of handlers) h(f); }
  });
  return {
    ready,
    onFrame(cb) { handlers.push(cb); },
    // gapMs spaces frames out so the radio's own queue and duty-cycle limits are respected
    async send(frame) { child.stdin.write(`TX ${Buffer.from(frame).toString("hex")}\n`); if (gapMs) await new Promise((r) => setTimeout(r, gapMs)); },
    close() { child.stdin.end(); child.kill(); },
  };
}
