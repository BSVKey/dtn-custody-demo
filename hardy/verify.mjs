// Verify what Hardy forwarded: extract each bundle's payload with Hardy's own `bundle`
// tool, verify the manifest against the pinned source key, every chunk against the Merkle
// root, every custody handoff against the pinned sender key, reassemble, and check the
// timing against the contact plan (nothing forwarded while the contact was closed).
import { readFileSync, readdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { makeDest } from "../agent/dest.mjs";
import { gapObject } from "../agent/lib/gap.mjs";

const DIR = "/tmp/fwd";
const plan = JSON.parse(readFileSync("/app/hardy/interop.json", "utf8"));
const pins = JSON.parse(readFileSync("/tmp/pins.json", "utf8"));
const t0 = Number(readFileSync("/tmp/t0", "utf8")), tsend = Number(readFileSync("/tmp/tsend", "utf8"));
const { down_s, up_s } = plan.occultation;
const LINK = "ipn:20 -> ipn:30 (route to ipn:2.*)";

const out = { ok: false, transport: "Aalyria Hardy hardy-bpa-server (ipn:20) with hardy-tvr contact windows; custody agent attached through Hardy's Application and CLA gRPC APIs", hardyRevision: readFileSync("/opt/HARDY_REVISION", "utf8").trim() };
try {
  const files = readdirSync(DIR).filter((f) => f.endsWith(".bundle")).sort();
  const got = files.map((f) => ({
    j: JSON.parse(execFileSync("bundle", ["extract", `${DIR}/${f}`]).toString("utf8")),
    arrivedS: (Number(readFileSync(`${DIR}/${f}.t`, "utf8")) - t0) / 1000,
  }));
  const manifest = got.find((g) => g.j.kind === "manifest").j.manifest;
  const d = makeDest({ priv: null, pub: "" }, manifest, [{ eid: pins.senderEid, pub: pins.senderPub }], { sourcePub: pins.sourcePub });
  let accepted = 0, custodyOk = 0;
  const delayed = [];
  for (const g of got.filter((x) => x.j.kind === "bundle")) {
    if (d.receiveBundle(g.j.bundle).ok) accepted++;
    for (const r of g.j.custody) d.recordCustody(g.j.bundle.bundleId, r);
    if (d.verifyChain(g.j.bundle.bundleId).ok) custodyOk++;
    if (g.arrivedS >= up_s - 1) delayed.push(g.j.bundle.bundleId);
  }
  const arr = got.map((g) => g.arrivedS);
  const complete = d.isComplete();
  const re = complete ? d.reassemble() : Buffer.alloc(0);
  const sentS = (tsend - t0) / 1000, firstS = Math.min(...arr), lastS = Math.max(...arr);
  const arrivedDuringGap = arr.filter((s) => s > down_s + 1 && s < up_s - 1).length;
  Object.assign(out, {
    bundlesForwarded: files.length, chunks: got.length - 1, expectedChunks: pins.chunks, accepted, custodyHandoffsVerified: custodyOk, complete,
    payloadMatches: createHash("sha256").update(re).digest("hex") === pins.payloadSha256,
    schedule: { gapDownS: down_s, gapUpS: up_s, sentAtS: +sentS.toFixed(1), firstForwardS: +firstS.toFixed(1), lastForwardS: +lastS.toFixed(1), arrivedDuringGap },
    heldAcrossGap: sentS > down_s && sentS < up_s && firstS >= up_s - 1 && arrivedDuringGap === 0,
    gap: gapObject({ link: LINK, linkEvents: [{ link: LINK, event: "down", t: down_s * 1000 }, { link: LINK, event: "up", t: up_s * 1000 }], delayed }),
  });
  out.ok = complete && out.payloadMatches && accepted === pins.chunks && custodyOk === pins.chunks && out.heldAcrossGap;
} catch (e) { out.error = e.message; }
console.log("HARDY_RESULT " + JSON.stringify(out));
process.exit(out.ok ? 0 : 1);
