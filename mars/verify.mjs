// Receiver side of the Mars run: verify every chunk and custody handoff that crossed the
// 240 s link, and check the timing: nothing can arrive before one light time has passed.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { makeDest } from "../agent/dest.mjs";

const RECV = "/tmp/n2/recv", OWLT = Number(process.env.OWLT || 240);
const pins = JSON.parse(readFileSync("/tmp/pins.json", "utf8"));
const tsend = Number(readFileSync("/tmp/tsend", "utf8"));
const out = { ok: false, transport: `JPL ION over LTP/UDP, netem ${OWLT} s each way`, ionCommit: readFileSync("/opt/ion/COMMIT", "utf8").trim() };
try {
  const files = readdirSync(RECV).map((n) => join(RECV, n)).filter((p) => statSync(p).isFile());
  const docs = files.map((f) => ({ j: JSON.parse(readFileSync(f, "utf8")), afterS: (statSync(f).mtimeMs - tsend) / 1000 }));
  const manifest = docs.find((d) => d.j.kind === "manifest/1").j;
  const dest = makeDest({ priv: null, pub: "" }, manifest, [{ eid: "ipn:1.2", pub: pins.senderPub }], { sourcePub: pins.sourcePub });
  let accepted = 0, custodyOk = 0;
  for (const { j } of docs.filter((d) => d.j.bundle)) {
    if (dest.receiveBundle(j.bundle).ok) accepted++;
    for (const r of j.custody) dest.recordCustody(j.bundle.bundleId, r);
    if (dest.verifyChain(j.bundle.bundleId).ok) custodyOk++;
  }
  const after = docs.map((d) => d.afterS);
  const complete = dest.isComplete();
  const re = complete ? dest.reassemble() : Buffer.alloc(0);
  Object.assign(out, {
    files: files.length, chunks: docs.length - 1, expectedChunks: pins.chunks, accepted, custodyHandoffsVerified: custodyOk, complete,
    payloadMatches: createHash("sha256").update(re).digest("hex") === pins.payloadSha256,
    firstArrivalAfterSendS: +Math.min(...after).toFixed(1), lastArrivalAfterSendS: +Math.max(...after).toFixed(1),
    noArrivalBeforeLightTime: Math.min(...after) >= OWLT - 1,
  });
  out.ok = complete && out.payloadMatches && accepted === pins.chunks && custodyOk === pins.chunks && out.noArrivalBeforeLightTime;
} catch (e) { out.error = e.message; }
console.log("MARS_RESULT " + JSON.stringify(out));
process.exit(out.ok ? 0 : 1);
