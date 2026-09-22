// R2 agent: runs at one µD3TN node (role via env), speaking real BPv7 over AAP. Reuses
// the tested JS agent (../agent) for all crypto. Custody piggybacks in the frame so no
// extra routing is needed: each relay appends its signed receipt and forwards to the
// next node's agent EID; µD3TN provides the store-and-forward BPv7 transport, holding
// bundles in its own storage across a contact gap (real bundle custody).
import { readFileSync } from "node:fs";
import { AAP } from "./aap.mjs";
import { importKeypair } from "../agent/lib/keys.mjs";
import { prepare } from "../agent/source.mjs";
import { makeRelay } from "../agent/relay.mjs";
import { makeDest } from "../agent/dest.mjs";
import { gapObject } from "../agent/lib/gap.mjs";

const E = process.env;
const role = E.ROLE;
const keys = JSON.parse(readFileSync(E.KEYS_FILE, "utf8"));
const log = (...a) => console.error(`[${role}]`, ...a);
const enc = (o) => Buffer.from(JSON.stringify(o), "utf8");
const dec = (b) => JSON.parse(b.toString("utf8"));

async function client() { const a = new AAP(); await a.connect("127.0.0.1", Number(E.AAP_PORT)); await a.register("app"); return a; }

async function runSource() {
  const kp = importKeypair(keys.source);
  const payload = Buffer.from("SPACE OCEAN R2 payload over real BPv7. ".repeat(Number(E.PAYLOAD_REPEAT || 20)), "utf8");
  const { manifest, bundles } = prepare(kp, payload, { payloadId: E.PAYLOAD_ID, chunkSize: Number(E.CHUNK_SIZE || 64) });
  const a = await client();
  await a.send(E.NEXT_EID, enc({ kind: "manifest", manifest }));
  for (const bundle of bundles) await a.send(E.NEXT_EID, enc({ kind: "bundle", bundle, custody: [] }));
  await a.send(E.NEXT_EID, enc({ kind: "eof", chunkCount: manifest.chunkCount }));
  log(`sent manifest + ${bundles.length} bundles into BPv7 (held by µD3TN until the next contact opens)`);
  setTimeout(() => process.exit(0), 500);
}

async function runRelay() {
  const kp = importKeypair(keys[E.ROLEKEY]);
  const relay = makeRelay(kp, E.NODE_EID);
  const a = await client();
  const t0 = Date.now();
  a.on("bundle", async (_src, payloadBuf) => {
    const f = dec(payloadBuf);
    if (f.kind === "bundle") {
      const receivedAt = Date.now() - t0;
      const receipt = relay.stamp(f.bundle, E.PREV_EID, receivedAt, receivedAt);
      f.custody.push(receipt);
      await a.send(E.NEXT_EID, enc(f));
    } else {
      await a.send(E.NEXT_EID, enc(f));
    }
  });
  log(`relay up on :${E.AAP_PORT}, forwarding to ${E.NEXT_EID}`);
}

async function runDest() {
  const destKp = importKeypair(keys.dest);
  const pinnedHops = [{ eid: E.HOP_A_EID, pub: keys.relaya.pub }, { eid: E.HOP_B_EID, pub: keys.relayb.pub }];
  let dest = null, manifest = null, scheduled = false;
  const bundles = [], t0 = Date.now();
  const a = await client();

  const finish = () => {
    for (const b of bundles) { const r = dest.receiveBundle(b.bundle); if (r.ok) for (const c of b.custody) dest.recordCustody(b.bundle.bundleId, c); }
    const complete = dest.isComplete();
    const re = complete ? dest.reassemble() : null;
    const rootMatches = re ? prepare(destKp, re, { payloadId: manifest.payloadId, chunkSize: Number(E.CHUNK_SIZE || 64) }).manifest.root === manifest.root : false;
    const chain = dest.verifyChain(bundles[0].bundle.bundleId);
    const settlementRef = E.SETTLEMENT_REF;
    const settle = dest.settle(destKp, { payloadId: manifest.payloadId, root: manifest.root, rail: "bsv", network: "bsv", settlementRef, payTo: E.PAY_TO, amountAtomic: Number(E.AMOUNT || 5942) }, { settlementRef });
    const gap = { downMs: Number(E.OCC_DOWN_MS || 0), upMs: Number(E.OCC_UP_MS || 0) };
    const g = gapObject({ link: "L2", linkEvents: [{ link: "L2", event: "down", t: gap.downMs }, { link: "L2", event: "up", t: gap.upMs }], delayed: bundles.map((b) => b.bundle.bundleId), lost: [] });
    const result = {
      ok: complete && rootMatches && chain.ok && settle.bind.ok,
      transport: "uD3TN BPv7 (mtcp CLA)", chunks: bundles.length, complete,
      reassembledBytes: re ? re.length : 0, rootMatches, custodyChainOk: chain.ok,
      deliveryBound: settle.bind.ok, gap: { downAt: g.downAt, upAt: g.upAt }, elapsedMs: Date.now() - t0,
    };
    console.log("R2_RESULT " + JSON.stringify(result));
    process.exit(result.ok ? 0 : 1);
  };
  const maybeFinish = () => { if (!scheduled && manifest && bundles.length >= manifest.chunkCount) { scheduled = true; setTimeout(finish, 600); } };

  a.on("bundle", (_src, payloadBuf) => {
    const f = dec(payloadBuf);
    if (f.kind === "manifest") { manifest = f.manifest; dest = makeDest(destKp, manifest, pinnedHops); maybeFinish(); }
    else if (f.kind === "bundle") { bundles.push({ bundle: f.bundle, custody: f.custody || [] }); maybeFinish(); }
    else if (f.kind === "eof" && !scheduled) setTimeout(finish, 600);
  });
  log(`dest up on :${E.AAP_PORT}`);
}

if (role === "source") runSource();
else if (role === "dest") runDest();
else runRelay();
