#!/usr/bin/env node
// Relief node daemon. One process per device, beside that device's µD3TN.
//
//   node relief/kit/node.mjs --config deploy/clinic-north.json [--data data/clinic-north]
//
//   clinic: every file dropped into <data>/outbox is sealed to the hub and sent, then moved
//           to <data>/sent with a .receipt.json (payload id and Merkle root).
//   relay:  stamps custody on every chunk and forwards it; claims go to <data>/claims.jsonl.
//   hub:    logs every frame to <data>/frames.jsonl (replayed on restart), writes each verified
//           report to <data>/inbox/<id>/ with evidence.json, and serves the dashboard.
//
// Transport: µD3TN over AAP at config.aap (default). --memory is for tests only.
import { readFileSync, writeFileSync, appendFileSync, mkdirSync, readdirSync, statSync, renameSync, existsSync } from "node:fs";
import { join, basename, resolve } from "node:path";
import { importKeypair } from "../../agent/lib/keys.mjs";
import { aapTransport } from "./lib/transport.mjs";
import { makeClinic, makeRelayNode, makeHub } from "./lib/roles.mjs";
import { startDashboard } from "./dashboard.mjs";

const safe = (id) => id.replace(/[^A-Za-z0-9._-]+/g, "_");
const log = (name, ...a) => console.log(new Date().toISOString(), `[${name}]`, ...a);

export async function startNode(config, { dataDir, transport, pollMs = 2000, now = Date.now } = {}) {
  const dir = resolve(dataDir || join("data", config.name));
  mkdirSync(dir, { recursive: true });
  const t = transport || await aapTransport({ eid: config.eid, host: config.aap.host, port: config.aap.port });
  const kp = importKeypair(config.sign);
  const L = (...a) => log(config.name, ...a);
  const stops = [() => t.close()];

  if (config.role === "clinic") {
    const outbox = join(dir, "outbox"), sent = join(dir, "sent");
    mkdirSync(outbox, { recursive: true }); mkdirSync(sent, { recursive: true });
    const clinic = makeClinic({ kp, eid: config.eid, next: config.next, hubEncPub: config.hubEncPub, chunkSize: config.chunkSize, now });
    const seen = new Map(); // name -> size at last poll; a file is sent once its size is stable
    let busy = false;
    const poll = async () => {
      if (busy) return; busy = true;
      try {
        for (const name of readdirSync(outbox)) {
          const p = join(outbox, name);
          const st = statSync(p);
          if (!st.isFile()) continue;
          if (seen.get(name) !== st.size) { seen.set(name, st.size); continue; }
          seen.delete(name);
          const r = await clinic.sendFile(t, { name, bytes: readFileSync(p) });
          renameSync(p, join(sent, name));
          writeFileSync(join(sent, `${name}.receipt.json`), JSON.stringify({ ...r, name, sentAt: new Date(now()).toISOString(), next: config.next }, null, 2) + "\n");
          L(`sent ${name}: ${r.chunks} chunks, root ${r.root.slice(0, 16)}..., id ${r.payloadId}`);
        }
      } catch (e) { L(`outbox error: ${e.message}`); }
      busy = false;
    };
    const iv = setInterval(poll, pollMs); stops.push(() => clearInterval(iv));
    L(`clinic up: drop files into ${outbox}; next hop ${config.next}`);
    return { role: "clinic", dir, poll, stop: () => stops.forEach((f) => f()) };
  }

  if (config.role === "relay") {
    const claims = join(dir, "claims.jsonl");
    const relay = makeRelayNode({ kp, eid: config.eid, next: config.next, now, onClaim: (c) => appendFileSync(claims, JSON.stringify(c) + "\n") });
    t.onFrame((buf) => relay.onFrame(t, buf).catch((e) => L(`forward error: ${e.message}`)));
    L(`relay up: custody for every chunk, forwarding to ${config.next}`);
    return { role: "relay", dir, relay, stop: () => stops.forEach((f) => f()) };
  }

  if (config.role === "hub") {
    const frames = join(dir, "frames.jsonl"), inbox = join(dir, "inbox");
    mkdirSync(inbox, { recursive: true });
    const hub = makeHub({ kp, eid: config.eid, encPriv: config.encPriv, directory: config.directory, ratePerBundleSats: config.ratePerBundleSats, holdThresholdMs: config.holdThresholdMs, now });
    const written = new Set();
    const persist = (id) => {
      const r = id && hub.report(id);
      if (!r || r.status !== "verified" || written.has(id)) return;
      written.add(id);
      const out = join(inbox, safe(id));
      mkdirSync(out, { recursive: true });
      writeFileSync(join(out, basename(r.file.name)), r.bytes);
      const { bytes, ...evidence } = r;
      writeFileSync(join(out, "evidence.json"), JSON.stringify({ payloadId: id, ...evidence }, null, 2) + "\n");
      L(`verified ${id} from ${r.clinic}: ${r.file.name} (${r.file.size} bytes) via ${r.route.slice(1, -1).join(" -> ")}${r.holds.map((h) => `; held ${h.transitMs >= 60000 ? `${Math.round(h.transitMs / 60000)} min` : `${Math.round(h.transitMs / 1000)} s`} on ${h.from} -> ${h.to}`).join("")}`);
    };
    // Replay the frame log so a restarted hub has its full state back.
    if (existsSync(frames)) {
      for (const line of readFileSync(frames, "utf8").split("\n")) if (line) { const { at, frame } = JSON.parse(line); persist(hub.ingest(Buffer.from(frame, "base64"), at)); }
      L(`replayed ${hub.state().reports.length} reports from ${frames}`);
    }
    t.onFrame((buf) => {
      const at = now();
      appendFileSync(frames, JSON.stringify({ at, frame: buf.toString("base64") }) + "\n");
      persist(hub.ingest(buf, at));
    });
    let dash = null;
    if (config.dashboard && config.dashboard.port != null) {
      dash = await startDashboard({ state: () => hub.state(), host: config.dashboard.host, port: config.dashboard.port, title: config.deployment });
      stops.push(() => dash.close());
      L(`dashboard on http://${config.dashboard.host}:${dash.port}/`);
    }
    L(`hub up: ${Object.keys(config.directory.clinics).length} clinics, ${Object.keys(config.directory.relays).length} relays pinned`);
    return { role: "hub", dir, hub, dashboard: dash, stop: () => stops.forEach((f) => f()) };
  }
  throw new Error(`unknown role ${config.role}`);
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname)) {
  const arg = (k) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : undefined; };
  const cfgPath = arg("--config");
  if (!cfgPath) { console.log("usage: node relief/kit/node.mjs --config <node.json> [--data <dir>]"); process.exit(2); }
  const config = JSON.parse(readFileSync(cfgPath, "utf8"));
  const n = await startNode(config, { dataDir: arg("--data") });
  const bye = () => { n.stop(); process.exit(0); };
  process.on("SIGINT", bye); process.on("SIGTERM", bye);
}
