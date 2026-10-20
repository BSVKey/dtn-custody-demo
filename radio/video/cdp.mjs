// Minimal Chrome DevTools Protocol driver: launch headless Chrome (optionally with a fake camera
// and microphone fed from files), open a page, evaluate JS, take screenshots. Used by record.mjs
// and compose.mjs.
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CHROME = process.env.CHROME || "C:/Program Files/Google/Chrome/Application/chrome.exe";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function launch({ port, video, audio, width = 390, height = 844, dpr = 2, mobile = true }) {
  const args = [`--remote-debugging-port=${port}`, `--user-data-dir=${mkdtempSync(join(tmpdir(), "cdp-"))}`, "--headless=new", "--no-first-run", "--no-default-browser-check",
    "--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream", "--autoplay-policy=no-user-gesture-required", "--mute-audio", `--window-size=${width},${height}`];
  if (video) args.push(`--use-file-for-fake-video-capture=${video}`);
  if (audio) args.push(`--use-file-for-fake-audio-capture=${audio}`);
  const proc = spawn(CHROME, args, { stdio: "ignore" });
  let ver;
  for (let i = 0; i < 50 && !ver; i++) { await sleep(200); ver = await fetch(`http://127.0.0.1:${port}/json/version`).then((r) => r.json()).catch(() => null); }
  if (!ver) throw new Error("chrome did not start");
  const t = await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: "PUT" }).then((r) => r.json());
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  await new Promise((r) => (ws.onopen = r));
  let id = 0; const pending = new Map(); const events = [];
  ws.onmessage = (m) => { const d = JSON.parse(m.data); if (d.id && pending.has(d.id)) { pending.get(d.id)(d); pending.delete(d.id); } else if (d.method) events.push(d); };
  const send = (method, params = {}) => new Promise((res, rej) => { const i = ++id; pending.set(i, (d) => (d.error ? rej(new Error(`${method}: ${d.error.message}`)) : res(d.result))); ws.send(JSON.stringify({ id: i, method, params })); });
  await send("Page.enable"); await send("Runtime.enable");
  await send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: dpr, mobile });
  return {
    send, events,
    async goto(url) { await send("Page.navigate", { url }); await sleep(1500); },
    async eval(expr) { const r = await send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text); return r.result.value; },
    async shot() { return Buffer.from((await send("Page.captureScreenshot", { format: "jpeg", quality: 85 })).data, "base64"); },
    async png() { return Buffer.from((await send("Page.captureScreenshot", { format: "png" })).data, "base64"); },
    close() { try { ws.close(); } catch {} proc.kill(); },
  };
}
export { sleep };
