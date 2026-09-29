// Custody agent at a uD3TN node for the mixed chain (uD3TN -> HDTN -> uD3TN), over AAP.
// ROLE=source: chunk + Merkle-commit a payload, sign the manifest and a custody handoff
//   per chunk at the sending node, and hand each to uD3TN for ipn:2.1.
// ROLE=dest: receive from uD3TN, verify the manifest against the pinned source key,
//   every chunk against the root, every handoff against the pinned sender key,
//   reassemble, and check arrival times against the scheduled gap. Emits MIX_RESULT.
import { readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { AAP } from "../r2/aap.mjs";
import { genKeypair } from "../agent/lib/keys.mjs";
import { prepare } from "../agent/source.mjs";
import { custodyReceipt } from "../agent/lib/receipt.mjs";
import { makeDest } from "../agent/dest.mjs";
import { gapObject } from "../agent/lib/gap.mjs";

const E = process.env;
const enc = (o) => Buffer.from(JSON.stringify(o), "utf8");
const connect = async () => { const a = new AAP(); await a.connect("127.0.0.1", Number(E.AAP_PORT)); await a.register("1"); return a; };
const SENDER_EID = "ipn:1.1";

async function source() {
  const src = genKeypair(), sender = genKeypair();
  const payload = Buffer.from("DTN CUSTODY across uD3TN and NASA HDTN: chunked, Merkle-committed, custody-signed. ".repeat(14), "utf8");
  const { manifest, bundles } = prepare(src, payload, { payloadId: "0xmixed-interop-001", chunkSize: 64 });
  writeFileSync("/tmp/pins.json", JSON.stringify({ sourcePub: src.pub, senderPub: sender.pub, payloadSha256: createHash("sha256").update(payload).digest("hex"), chunks: bundles.length }));
  const a = await connect();
  await a.send(E.DEST_EID, enc({ kind: "manifest", manifest }));
  const now = Date.now();
  for (const b of bundles) {
    const handoff = custodyReceipt(sender, { payloadId: b.payloadId, bundleId: b.bundleId, prevHop: "app:source", thisHop: SENDER_EID, receivedAt: now, forwardedAt: now });
    await a.send(E.DEST_EID, enc({ kind: "bundle", bundle: b, custody: [handoff] }));
  }
  console.log(`[mix] uD3TN ipn:1 accepted manifest + ${bundles.length} bundles for ${E.DEST_EID}`);
  setTimeout(() => process.exit(0), 500);
}

async function dest() {
  const plan = JSON.parse(readFileSync("/app/mix/interop.json", "utf8"));
  const { down_s, up_s } = plan.occultation;
  const a = await connect();
  const got = [];
  let manifest = null;
  const finish = () => {
    const pins = JSON.parse(readFileSync("/tmp/pins.json", "utf8"));
    const t0 = Number(readFileSync("/tmp/t0", "utf8")), tsend = Number(readFileSync("/tmp/tsend", "utf8"));
    const out = { ok: false, transport: `uD3TN ipn:1 -> NASA HDTN ipn:10 -> uD3TN ipn:2, TCPCLv3 both links, BPv7`, hdtnCommit: readFileSync("/opt/HDTN/COMMIT", "utf8").trim(), ud3tnCommit: readFileSync("/opt/ud3tn/COMMIT", "utf8").trim() };
    try {
      const d = makeDest({ priv: null, pub: "" }, manifest, [{ eid: SENDER_EID, pub: pins.senderPub }], { sourcePub: pins.sourcePub });
      let accepted = 0, custodyOk = 0;
      const delayed = [];
      for (const g of got.filter((x) => x.f.kind === "bundle")) {
        if (d.receiveBundle(g.f.bundle).ok) accepted++;
        for (const r of g.f.custody) d.recordCustody(g.f.bundle.bundleId, r);
        if (d.verifyChain(g.f.bundle.bundleId).ok) custodyOk++;
        if (g.arrivedS >= up_s) delayed.push(g.f.bundle.bundleId);
      }
      const arr = got.map((g) => g.arrivedS);
      const complete = d.isComplete();
      const re = complete ? d.reassemble() : Buffer.alloc(0);
      const sentS = (tsend - t0) / 1000, firstS = Math.min(...arr), lastS = Math.max(...arr);
      const arrivedDuringGap = arr.filter((s) => s > down_s + 2 && s < up_s).length;
      Object.assign(out, {
        received: got.length, chunks: got.length - 1, expectedChunks: pins.chunks, accepted, custodyHandoffsVerified: custodyOk, complete,
        payloadMatches: createHash("sha256").update(re).digest("hex") === pins.payloadSha256,
        schedule: { gapDownS: down_s, gapUpS: up_s, sentAtS: +sentS.toFixed(1), firstArrivalS: +firstS.toFixed(1), lastArrivalS: +lastS.toFixed(1), arrivedDuringGap },
        heldAcrossGap: sentS > down_s && sentS < up_s && firstS >= up_s - 1 && arrivedDuringGap === 0,
        gap: gapObject({ link: "L2 (ipn:10 -> ipn:2)", linkEvents: [{ link: "L2 (ipn:10 -> ipn:2)", event: "down", t: down_s * 1000 }, { link: "L2 (ipn:10 -> ipn:2)", event: "up", t: up_s * 1000 }], delayed }),
      });
      out.ok = complete && out.payloadMatches && accepted === pins.chunks && custodyOk === pins.chunks && out.heldAcrossGap;
    } catch (e) { out.error = e.message; }
    console.log("MIX_RESULT " + JSON.stringify(out));
    process.exit(out.ok ? 0 : 1);
  };
  let timer = null;
  a.on("bundle", (_src, buf) => {
    const t0 = Number(readFileSync("/tmp/t0", "utf8"));
    const f = JSON.parse(buf.toString("utf8"));
    got.push({ f, arrivedS: (Date.now() - t0) / 1000 });
    if (f.kind === "manifest") manifest = f.manifest;
    const pins = JSON.parse(readFileSync("/tmp/pins.json", "utf8"));
    if (manifest && got.length >= pins.chunks + 1 && !timer) timer = setTimeout(finish, 500);
  });
  setTimeout(() => { if (!timer) finish(); }, Number(E.DEST_TIMEOUT_MS || 70000));
  console.log(`[mix] receiver agent registered at uD3TN ipn:2.1`);
}

E.ROLE === "source" ? source() : dest();
