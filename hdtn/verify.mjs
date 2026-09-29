// Receiver side: read what HDTN's BpReceiveFile saved, verify the manifest against the
// pinned source key, every chunk against the Merkle root, each custody handoff against the
// pinned sender key, reassemble, and check the timing against the compiled contact plan:
// nothing may arrive while the scheduled gap is open, and bundles sent into the gap must
// arrive after it closes (HDTN stored them). Emits HDTN_RESULT {...}.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { makeDest } from "../agent/dest.mjs";
import { gapObject } from "../agent/lib/gap.mjs";

const RECV = process.env.RECV_DIR || "/tmp/recv";
const plan = JSON.parse(readFileSync("/app/hdtn/interop.json", "utf8"));
const pins = JSON.parse(readFileSync("/tmp/pins.json", "utf8"));
const t0 = Number(readFileSync("/tmp/t0", "utf8"));
const tsend = Number(readFileSync("/tmp/tsend", "utf8"));
const { down_s, up_s } = plan.occultation;

const files = [];
(function walk(d) { for (const n of readdirSync(d)) { const p = join(d, n); statSync(p).isDirectory() ? walk(p) : files.push(p); } })(RECV);
const byName = (re) => files.filter((f) => re.test(f));
const out = { ok: false, transport: "NASA HDTN hdtn-one-process (router ipn:10), BpSendFile ipn:1.1 -> BpReceiveFile ipn:2.1, TCPCLv4", hdtnCommit: readFileSync("/opt/HDTN/COMMIT", "utf8").trim() };
try {
  const manifest = JSON.parse(readFileSync(byName(/manifest\.json$/)[0], "utf8"));
  const dest = makeDest({ priv: null, pub: "" }, manifest, [{ eid: "ipn:1.1", pub: pins.senderPub }], { sourcePub: pins.sourcePub });
  const chunkFiles = byName(/chunk-\d+\.json$/);
  let accepted = 0, custodyOk = 0;
  const arrivalsS = [];
  const delayed = [];
  for (const f of chunkFiles) {
    const { bundle, custody } = JSON.parse(readFileSync(f, "utf8"));
    const arrivedS = (statSync(f).mtimeMs - t0) / 1000;
    arrivalsS.push(arrivedS);
    if (dest.receiveBundle(bundle).ok) accepted++;
    for (const r of custody) dest.recordCustody(bundle.bundleId, r);
    if (dest.verifyChain(bundle.bundleId).ok) custodyOk++;
    if (arrivedS >= up_s) delayed.push(bundle.bundleId);
  }
  const complete = dest.isComplete();
  const reassembled = complete ? dest.reassemble() : Buffer.alloc(0);
  const sentS = (tsend - t0) / 1000;
  const firstS = Math.min(...arrivalsS), lastS = Math.max(...arrivalsS);
  const arrivedDuringGap = arrivalsS.filter((s) => s > down_s + 2 && s < up_s).length; // 2 s grace for bundles already in flight
  Object.assign(out, {
    chunks: chunkFiles.length, expectedChunks: pins.chunks, accepted, custodyHandoffsVerified: custodyOk, complete,
    payloadMatches: createHash("sha256").update(reassembled).digest("hex") === pins.payloadSha256,
    schedule: { gapDownS: down_s, gapUpS: up_s, sentAtS: +sentS.toFixed(1), firstArrivalS: +firstS.toFixed(1), lastArrivalS: +lastS.toFixed(1), arrivedDuringGap },
    heldAcrossGap: sentS > down_s && sentS < up_s && firstS >= up_s - 1 && arrivedDuringGap === 0,
    gap: gapObject({ link: "L2 (ipn:10 -> ipn:2)", linkEvents: [{ link: "L2 (ipn:10 -> ipn:2)", event: "down", t: down_s * 1000 }, { link: "L2 (ipn:10 -> ipn:2)", event: "up", t: up_s * 1000 }], delayed }),
  });
  out.ok = complete && out.payloadMatches && accepted === pins.chunks && custodyOk === pins.chunks && out.heldAcrossGap;
} catch (e) {
  out.error = e.message;
}
console.log("HDTN_RESULT " + JSON.stringify(out));
process.exit(out.ok ? 0 : 1);
