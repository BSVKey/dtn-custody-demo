#!/usr/bin/env node
// Deep-space IP store-and-forward scenarios for the QUIC workbench, then custody receipts for each.
//
// Each scenario is a chain: mission operations (GND) -> Deep Space Network (DSN) -> [relay
// orbiter] -> spacecraft or lander, with the one-way light time, data rates and contact windows
// below. The workbench (github.com/deepspaceip/dipt-quic-workbench) forwards IP packets with
// store-and-forward buffers and time warping, so a day of light time simulates in seconds. For
// every run, ip-sf/receipts.mjs then builds one signed custody receipt per node per contact,
// gap records for the outages, and attributes anything not delivered to the last node that
// signed for it.
//
// Contacts: the workbench drops packets still in flight when a link goes down (an occultation).
// Where the light time is longer than a station pass (Voyager, Neptune, Pluto) the long-haul link
// is modelled as continuous Deep Space Network coverage (its three complexes around the globe)
// after an initial period with the spacecraft not yet in view, during which the DSN stores and
// forwards. Where passes are longer than the light time (Saturn, Titan, the solar probes), daily
// passes and relay contacts are modelled directly.
//
// Distances are approximate for early October 2026. Voyager 1 and 2, Parker Solar Probe and
// Solar Orbiter are real spacecraft; the Saturn, Titan, Neptune and Pluto missions are
// hypothetical orbiters and landers placed at those planets' real distances.
//
//   node ip-sf/deep-space.mjs [--only=voyager1,saturn] [--workbench=../dipt-quic-workbench]
import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";

const arg = (k, d) => process.argv.find((a) => a.startsWith(`--${k}=`))?.split("=")[1] ?? d;
const WB = resolve(arg("workbench", "../dipt-quic-workbench"));
const HERE = resolve("ip-sf");
const H = 3600000, D = 24 * H, MIN = 60000;
const AU_MS = 499005; // light time for one astronomical unit, in ms

// A repeating contact: up for `up` ms every `every` ms, starting at `offset`, until `until`.
const passes = (up, every, until, offset = 0) => { const w = []; for (let t = offset; t < until; t += every) w.push([t, Math.min(t + up, until)]); return w; };

const scenarios = {
  voyager1: { title: "Voyager 1 (interstellar space)", real: true, au: 171.1, hops: [
    { name: "VGR1", down: 160, up: 16, windows: (T) => [[6 * H, T]] } ], requests: 2, response: 1024, horizon: 40 * D },
  voyager2: { title: "Voyager 2 (interstellar space)", real: true, au: 144.4, hops: [
    { name: "VGR2", down: 160, up: 16, windows: (T) => [[14 * H, T]] } ], requests: 2, response: 1024, horizon: 40 * D },
  saturn: { title: "Saturn orbiter (hypothetical)", real: false, au: 8.6, hops: [
    { name: "SATURN-ORB", down: 100000, up: 2000, windows: (T) => passes(9 * H, D, T) } ], requests: 5, response: 8192, horizon: 6 * D },
  titan: { title: "Titan lander via Saturn orbiter (hypothetical)", real: false, au: 8.6, hops: [
    { name: "SATURN-ORB", down: 100000, up: 2000, windows: (T) => passes(9 * H, D, T) },
    { name: "TITAN-LANDER", delayMs: 20, down: 250000, up: 250000, windows: (T) => passes(30 * MIN, 8 * H, T, 2 * H) } ], requests: 5, response: 8192, horizon: 8 * D },
  "titan-reboot": { title: "Titan lander via Saturn orbiter, orbiter reboots holding data (hypothetical)", real: false, au: 8.6, hops: [
    { name: "SATURN-ORB", down: 100000, up: 2000, windows: (T) => passes(9 * H, D, T) },
    { name: "TITAN-LANDER", delayMs: 20, down: 250000, up: 250000, windows: (T) => passes(30 * MIN, 8 * H, T, 2 * H) } ], requests: 5, response: 8192, horizon: 8 * D,
    // The orbiter loses everything it is holding at hour 20, while waiting for the next Earth pass.
    extraEvents: [{ relative_time_ms: 20 * H, node: { id: "SATURN-ORB", clear_buffer: true } }] },
  neptune: { title: "Neptune orbiter (hypothetical)", real: false, au: 28.9, hops: [
    { name: "NEPTUNE-ORB", down: 10000, up: 2000, windows: (T) => [[6 * H, T]] } ], requests: 3, response: 4096, horizon: 10 * D },
  pluto: { title: "Pluto orbiter (hypothetical)", real: false, au: 34.8, hops: [
    { name: "PLUTO-ORB", down: 2000, up: 2000, windows: (T) => [[6 * H, T]] } ], requests: 3, response: 4096, horizon: 10 * D },
  parker: { title: "Parker Solar Probe (perihelion blackout, then daily passes)", real: true, au: 1.0, hops: [
    { name: "PARKER", down: 100000, up: 2000, windows: (T) => passes(8 * H, D, T, 3 * D) } ], requests: 5, response: 8192, horizon: 8 * D },
  solarorbiter: { title: "Solar Orbiter", real: true, au: 0.8, hops: [
    { name: "SOLO", down: 100000, up: 2000, windows: (T) => passes(8 * H, D, T) } ], requests: 5, response: 8192, horizon: 4 * D },
};

const U64MAX = "18446744073709551615";
function quic(rttMs) {
  return { initial_rtt_ms: rttMs, maximum_idle_timeout_ms: 100000000000, packet_threshold: 4294967295, mtu_discovery: false,
    maximize_send_and_receive_windows: true, congestion_controller: "no_cc", ack_frequency_config: { max_ack_delay_ms: "__U64MAX__", ack_eliciting_threshold: 10 } };
}

function build(key, s) {
  const lightMs = Math.round(s.au * AU_MS);
  // Chain: GND -(100 ms, always up)- DSN -(light time)- hop1 -(hop delay)- hop2 ...
  const names = ["GND", "DSN", ...s.hops.map((h) => h.name)];
  const legs = [{ delayMs: 100, down: 10e6, up: 10e6, windows: null }, ...s.hops.map((h, i) => ({ delayMs: h.delayMs ?? (i === 0 ? lightMs : 20), down: h.down, up: h.up, windows: h.windows(s.horizon) }))];
  const rtt = 2 * legs.reduce((a, l) => a + l.delayMs, 0);
  const nodes = names.map((id, k) => {
    const ifaces = [];
    if (k > 0) ifaces.push({ addresses: [{ address: `10.0.${k - 1}.2/24` }], routes: names.slice(0, k - 1).map((_, j) => ({ destination: `10.0.${j}.0/24`, next: `10.0.${k - 1}.1`, cost: 100 })) });
    if (k < names.length - 1) ifaces.push({ addresses: [{ address: `10.0.${k}.1/24` }], routes: names.slice(k + 2).map((_, j) => ({ destination: `10.0.${k + 1 + j}.0/24`, next: `10.0.${k}.2`, cost: 100 })) });
    return { id, buffer_size_bytes: 1000000000, interfaces: ifaces, quic: quic(rtt) };
  });
  const links = [], events = [];
  legs.forEach((l, k) => {
    const a = names[k], b = names[k + 1];
    // "down" is the rate toward Earth (from the far node), "up" the rate away from Earth.
    links.push({ id: `${a}-${b}`, source: `10.0.${k}.1`, target: `10.0.${k}.2`, delay_ms: l.delayMs, bandwidth_bps: l.up });
    links.push({ id: `${b}-${a}`, source: `10.0.${k}.2`, target: `10.0.${k}.1`, delay_ms: l.delayMs, bandwidth_bps: l.down });
    if (l.windows) for (const [from, to] of l.windows) for (const id of [`${a}-${b}`, `${b}-${a}`]) {
      events.push({ relative_time_ms: from, link: { id, status: "up" } });
      events.push({ relative_time_ms: to, link: { id, status: "down" } });
    }
  });
  events.push(...(s.extraEvents || []));
  events.sort((x, y) => x.relative_time_ms - y.relative_time_ms);
  const dir = `${HERE}/runs/deep-${key}`;
  mkdirSync(dir, { recursive: true });
  const graph = JSON.stringify({ type: "NetworkGraph", nodes, links }, null, 1).replaceAll('"__U64MAX__"', U64MAX);
  writeFileSync(`${dir}/graph.json`, graph);
  writeFileSync(`${dir}/events.json`, JSON.stringify({ type: "NetworkEvents", events }, null, 1));
  writeFileSync(`${dir}/traffic.json`, JSON.stringify({ traffic_patterns: [{ type: "quic_request_response", client: "10.0.0.1:8080", server: `10.0.${names.length - 2}.2:8080`, requests: s.requests, response_size_bytes: s.response }] }, null, 1));
  return { dir, lightMs, names, legs };
}

const only = arg("only") ? arg("only").split(",") : Object.keys(scenarios);
const rows = [];
for (const key of only) {
  const s = scenarios[key];
  const { dir, lightMs, names } = build(key, s);
  const win = (p) => p.replace(/^\/c\//, "C:/");
  let out = "";
  try {
    out = execFileSync("docker", ["run", "--rm", "-v", `${win(WB)}:/w`, "-v", "qwb-target:/w/target", "-v", `${win(dir)}:/run`, "-w", "/run", "rust:1.93",
      "/w/target/release/quinn-workbench", "simulate", "--network-graph", "graph.json", "--network-events", "events.json", "--traffic", "traffic.json"],
      { encoding: "utf8", maxBuffer: 1 << 28, env: { ...process.env, MSYS_NO_PATHCONV: "1" } });
  } catch (e) { out = String(e.stdout || "") + String(e.stderr || e.message); }
  writeFileSync(`${dir}/stdout.txt`, out);
  const done = out.match(/([\d.]+)s DONE \(conn = \w+, request\/response amount = (\d+)\)/);
  let r = {};
  if (existsSync(`${dir}/replay-log.json`)) {
    r = JSON.parse(execFileSync(process.execPath, [`${HERE}/receipts.mjs`, `--dir=${dir}`, `--graph=${dir}/graph.json`, `--events=${dir}/events.json`, `--name=${key}`], { encoding: "utf8" }));
  }
  const row = { key, title: s.title, real: s.real, au: s.au, oneWay: lightMs, path: names.join(" > "), requests: s.requests,
    completed: done ? Number(done[2]) : 0, doneAtS: done ? Number(done[1]) : null, ...r };
  rows.push(row);
  console.log(`${key}: light ${(lightMs / H).toFixed(2)} h one way; ${row.completed}/${s.requests} exchanges${done ? ` done at ${(row.doneAtS / 86400).toFixed(2)} days` : " NOT done"}; ${r.receipts ?? 0} receipts (${r.receiptsVerified ?? 0} verified), ${r.gapRecords ?? 0} gap records, not delivered ${r.notDelivered ?? "?"}`);
}
writeFileSync(`${HERE}/runs/deep-space-summary.json`, JSON.stringify(rows, null, 1));
