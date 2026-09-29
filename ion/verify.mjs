// Receiver side of the ION run: read what bprecvfile saved (testfile1, testfile2, ...),
// find the manifest and chunks by content, verify the manifest against the pinned source
// key, every chunk against the Merkle root, each custody handoff against the pinned sender
// key, reassemble, and check timing against the contact plan: nothing may arrive while
// the scheduled gap is open, and bundles sent into the gap must arrive after it closes
// (ION held them). Emits ION_RESULT {...}.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { makeDest } from "../agent/dest.mjs";
import { gapObject } from "../agent/lib/gap.mjs";

const RECV = process.env.RECV_DIR || "/tmp/n2/recv";
const plan = JSON.parse(readFileSync("/app/ion/interop.json", "utf8"));
const pins = JSON.parse(readFileSync("/tmp/pins.json", "utf8"));
const t0 = Number(readFileSync("/tmp/t0", "utf8"));
const tsend = Number(readFileSync("/tmp/tsend", "utf8"));
const { down_s, up_s } = plan.occultation;
const LINK = "L1 (ipn:1 -> ipn:2)";

const out = { ok: false, transport: "JPL ION, node ipn:1 bpsendfile -> node ipn:2 bprecvfile, UDP convergence layer, contact graph routing", ionCommit: readFileSync("/opt/ion/COMMIT", "utf8").trim() };
try {
  const files = readdirSync(RECV).map((n) => join(RECV, n)).filter((p) => statSync(p).isFile());
  const docs = files.map((f) => ({ f, j: JSON.parse(readFileSync(f, "utf8")), arrivedS: (statSync(f).mtimeMs - t0) / 1000 }));
  const manifest = docs.find((d) => d.j.kind === "manifest/1").j;
  const dest = makeDest({ priv: null, pub: "" }, manifest, [{ eid: "ipn:1.2", pub: pins.senderPub }], { sourcePub: pins.sourcePub });
  const chunks = docs.filter((d) => d.j.bundle);
  let accepted = 0, custodyOk = 0;
  const delayed = [];
  for (const { j, arrivedS } of chunks) {
    if (dest.receiveBundle(j.bundle).ok) accepted++;
    for (const r of j.custody) dest.recordCustody(j.bundle.bundleId, r);
    if (dest.verifyChain(j.bundle.bundleId).ok) custodyOk++;
    if (arrivedS >= up_s) delayed.push(j.bundle.bundleId);
  }
  const arrivalsS = docs.map((d) => d.arrivedS);
  const complete = dest.isComplete();
  const reassembled = complete ? dest.reassemble() : Buffer.alloc(0);
  const sentS = (tsend - t0) / 1000;
  const firstS = Math.min(...arrivalsS), lastS = Math.max(...arrivalsS);
  const arrivedDuringGap = arrivalsS.filter((s) => s > down_s + 2 && s < up_s).length;
  Object.assign(out, {
    files: files.length, chunks: chunks.length, expectedChunks: pins.chunks, accepted, custodyHandoffsVerified: custodyOk, complete,
    payloadMatches: createHash("sha256").update(reassembled).digest("hex") === pins.payloadSha256,
    schedule: { gapDownS: down_s, gapUpS: up_s, sentAtS: +sentS.toFixed(1), firstArrivalS: +firstS.toFixed(1), lastArrivalS: +lastS.toFixed(1), arrivedDuringGap },
    heldAcrossGap: sentS > down_s && sentS < up_s && firstS >= up_s - 1 && arrivedDuringGap === 0,
    gap: gapObject({ link: LINK, linkEvents: [{ link: LINK, event: "down", t: down_s * 1000 }, { link: LINK, event: "up", t: up_s * 1000 }], delayed }),
  });
  out.ok = complete && out.payloadMatches && accepted === pins.chunks && custodyOk === pins.chunks && out.heldAcrossGap;
} catch (e) {
  out.error = e.message;
}
console.log("ION_RESULT " + JSON.stringify(out));
process.exit(out.ok ? 0 : 1);
