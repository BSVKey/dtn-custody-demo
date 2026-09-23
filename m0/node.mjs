// M0 spike: a single node process (role = source | relay | dest) that runs the real
// agent over TCP with store-and-forward. This is a REAL transport (sockets,
// serialization, async, queueing across a link outage), not the in-process sim. In
// the Docker/netem variant the same processes run in separate netns with `tc netem`
// shaping the veths; here they run on localhost. BPv7/uD3TN is the eventual drop-in
// (transport/bpv7-adapter.md), same contract.
//
// Frames are newline-delimited JSON: {type:'manifest'|'bundle'|'custody', ...}.
// Occultation: a relay whose OUTBOUND link is occulted queues all outbound frames
// during [downMs, upMs) and flushes on link-up (store-and-forward).
import net from "node:net";
import { readFileSync } from "node:fs";
import { importKeypair } from "../agent/lib/keys.mjs";
import { prepare } from "../agent/source.mjs";
import { makeRelay } from "../agent/relay.mjs";
import { makeDest } from "../agent/dest.mjs";
import { gapObject } from "../agent/lib/gap.mjs";

const cfg = JSON.parse(readFileSync(process.env.M0_CONFIG, "utf8"));
const role = process.env.M0_ROLE;
const keys = JSON.parse(readFileSync(cfg.keysFile, "utf8"));
const log = (...a) => console.error(`[${role}]`, ...a);

const EID = cfg.eids; // { source, relaya, relayb, dest }
const BIND = "0.0.0.0";
// Where to reach a downstream node. Local spike: 127.0.0.1. Docker/netem: the netns IP.
const hostOf = (name) => (cfg.hosts && cfg.hosts[name]) || "127.0.0.1";

function frame(obj) { return JSON.stringify(obj) + "\n"; }
function onFrames(socket, handler) {
  socket.on("error", () => {}); // swallow resets when a peer exits; framing tolerates it
  let buf = "";
  socket.on("data", (d) => {
    buf += d.toString("utf8");
    let i;
    while ((i = buf.indexOf("\n")) >= 0) { const l = buf.slice(0, i); buf = buf.slice(i + 1); if (l) handler(JSON.parse(l)); }
  });
}
// Connect with retry (downstream node may still be starting).
function connectRetry(port, host = "127.0.0.1", tries = 50) {
  return new Promise((resolve, reject) => {
    const attempt = (n) => {
      const s = net.connect(port, host);
      s.once("connect", () => { s.on("error", () => {}); resolve(s); });
      s.once("error", () => { if (n <= 0) reject(new Error("connect failed")); else setTimeout(() => attempt(n - 1), 100); });
    };
    attempt(tries);
  });
}

// -------- SOURCE ------------------------------------------------------------------
async function runSource() {
  const kp = importKeypair(keys.source);
  const payload = Buffer.from(cfg.payloadText || ("SPACE OCEAN M0 spike payload. ".repeat(40)), "utf8");
  const { manifest, bundles } = prepare(kp, payload, { payloadId: cfg.payloadId, chunkSize: cfg.chunkSize || 64 });
  const out = await connectRetry(cfg.ports.relaya, hostOf("relaya"));
  out.write(frame({ type: "manifest", manifest }));
  const stagger = cfg.sourceStaggerMs || 0; // space sends so a blackout overlaps in-flight bundles
  let i = 0;
  const sendNext = () => {
    if (i < bundles.length) { out.write(frame({ type: "bundle", bundle: bundles[i++] })); setTimeout(sendNext, stagger); }
    else {
      out.write(frame({ type: "eof", chunkCount: manifest.chunkCount }));
      log(`sent manifest + ${bundles.length} bundles`);
      out.end(() => setTimeout(() => process.exit(0), 100));
    }
  };
  sendNext();
}

// -------- RELAY -------------------------------------------------------------------
async function runRelay(which) {
  const kp = importKeypair(keys[which]);            // which = 'relaya' | 'relayb'
  const relay = makeRelay(kp, EID[which]);
  const prevHop = which === "relaya" ? EID.source : EID.relaya;
  const myPort = which === "relaya" ? cfg.ports.relaya : cfg.ports.relayb;
  const nextPort = which === "relaya" ? cfg.ports.relayb : cfg.ports.dest;

  // App-level occultation (cfg.appHold) is used for the local spike, where there is no
  // real link to drop. In the Docker/netem variant cfg.appHold is false and the outage
  // is a REAL `tc netem loss 100%` window on the veth (occult.sh); TCP retransmission
  // then carries the held bundles through once the link clears.
  const occ = cfg.appHold === true && cfg.occultation && cfg.occultation.relay === which ? cfg.occultation : null;
  let linkDown = !!occ && occ.downMs === 0;
  const queue = [];
  const t0 = Date.now();
  const out = await connectRetry(nextPort, hostOf(which === "relaya" ? "relayb" : "dest"));
  const send = (f) => { if (linkDown) queue.push(f); else out.write(f); };
  if (occ) {
    if (occ.downMs > 0) setTimeout(() => { linkDown = true; log(`link DOWN (+${occ.downMs}ms)`); }, occ.downMs);
    setTimeout(() => {
      linkDown = false;
      log(`link UP (+${occ.upMs}ms), flushing ${queue.length} queued frames`);
      while (queue.length) out.write(queue.shift());
    }, occ.upMs);
  }

  const server = net.createServer((sock) => {
    onFrames(sock, (f) => {
      if (f.type === "bundle") {
        const receivedAt = Date.now() - t0;
        const forwardedAt = linkDown ? occ.upMs : receivedAt; // reflects the hold
        const receipt = relay.stamp(f.bundle, prevHop, receivedAt, forwardedAt);
        send(frame(f));                                   // pass the bundle on
        send(frame({ type: "custody", receipt }));        // add our custody receipt
      } else {
        send(frame(f));                                   // manifest / other custody / eof pass through
      }
    });
  });
  server.listen(myPort, BIND, () => log(`listening :${myPort} -> :${nextPort}${occ ? " (owns occulted link)" : ""}`));
}

// -------- DEST --------------------------------------------------------------------
async function runDest() {
  const destKp = importKeypair(keys.dest);
  const pinnedHops = [{ eid: EID.relaya, pub: keys.relaya.pub }, { eid: EID.relayb, pub: keys.relayb.pub }];
  let dest = null, manifest = null, expected = null;
  const pendingBundles = [], pendingCustody = [];
  const t0 = Date.now();

  const finish = () => {
    for (const b of pendingBundles) { const r = dest.receiveBundle(b); if (!r.ok) log(`chunk ${b.index} rejected: ${r.reason}`); }
    for (const c of pendingCustody) dest.recordCustody(c.bundleId, c.receipt);
    const complete = dest.isComplete();
    const re = complete ? dest.reassemble() : null;
    const sampleId = pendingBundles[0].bundleId;
    const chain = dest.verifyChain(sampleId);
    const settlementRef = cfg.settlementRef;
    const settle = dest.settle(destKp, { payloadId: manifest.payloadId, root: manifest.root, rail: "bsv", network: "bsv", settlementRef, payTo: cfg.payTo, amountAtomic: cfg.amountAtomic }, { settlementRef });
    const gap = cfg.occultation ? gapObject({ link: cfg.occultation.link, linkEvents: [{ link: cfg.occultation.link, event: "down", t: cfg.occultation.downMs }, { link: cfg.occultation.link, event: "up", t: cfg.occultation.upMs }], delayed: pendingBundles.map((b) => b.bundleId), lost: [] }) : null;
    const result = {
      ok: complete && re && manifestRootMatches(re) && chain.ok && settle.bind.ok,
      chunks: pendingBundles.length, complete, reassembledBytes: re ? re.length : 0,
      custodyChainOk: chain.ok, deliveryBound: settle.bind.ok,
      gap: gap ? { downAt: gap.downAt, upAt: gap.upAt, delayed: gap.bundlesDelayed.length } : null,
      elapsedMs: Date.now() - t0,
    };
    function manifestRootMatches(bytes) {
      const re2 = prepare(destKp, bytes, { payloadId: manifest.payloadId, chunkSize: cfg.chunkSize || 64 });
      return re2.manifest.root === manifest.root;
    }
    console.log("M0_RESULT " + JSON.stringify(result));
    log(`done in ${result.elapsedMs}ms: ok=${result.ok}`);
    process.exit(result.ok ? 0 : 1);
  };

  let scheduled = false;
  const grace = cfg.graceMs || 500;
  const maybeFinish = () => {
    if (!scheduled && manifest && pendingBundles.length >= manifest.chunkCount) {
      scheduled = true; setTimeout(finish, grace); // let trailing custody frames land
    }
  };
  const server = net.createServer((sock) => {
    onFrames(sock, (f) => {
      if (f.type === "manifest") { manifest = f.manifest; dest = makeDest(destKp, manifest, pinnedHops, { sourcePub: keys.source.pub }); maybeFinish(); }
      else if (f.type === "bundle") { pendingBundles.push(f.bundle); maybeFinish(); }
      else if (f.type === "custody") pendingCustody.push({ bundleId: f.receipt.bundleId, receipt: f.receipt });
      else if (f.type === "eof" && !scheduled) setTimeout(finish, grace); // fallback trigger
    });
  });
  server.listen(cfg.ports.dest, BIND, () => log(`listening :${cfg.ports.dest}`));
}

if (role === "source") runSource();
else if (role === "dest") runDest();
else if (role === "relaya" || role === "relayb") runRelay(role);
else { log("unknown role"); process.exit(2); }
