// Report on the Solar System Internet run on Hardy (results.json from net.mjs): what was
// delivered, who signed (Hardy's filter or a JS endpoint), what the hop counts and Previous
// Node blocks say about unsigned relays, and clearing between operators from the receipts,
// including forged claims made with the stolen relay key.
//   node ssi/hardy/report.mjs <dir> [--json]
import { readFileSync, writeFileSync } from "node:fs";
import { decode } from "../../transport/bpv7/cbor.mjs";
import { decodeBundle } from "../../transport/bpv7/bundle.mjs";
import { readBlockItems, receiptFields, bundleIdentity, stampBundleV2 } from "../../transport/bpv7/receipt-v2.mjs";
import { Keyring } from "../../transport/bpv7/keyring.mjs";
import { keyFromSeed } from "./plan.mjs";
import { clear } from "../settle.mjs";

const dir = process.argv[2];
const P = JSON.parse(readFileSync(`${dir}/plan.json`, "utf8"));
const R = JSON.parse(readFileSync(`${dir}/results.json`, "utf8"));
const DTN_EPOCH = Date.UTC(2000, 0, 1), H = 3.6e6;
const opOf = (eid) => P.hardy.find((h) => h.eid === eid)?.op ?? "science";
const hardyEids = new Set(P.hardy.map((h) => h.eid));

const out = { scale: P.scale, hours: P.hours, hardyNodes: P.hardy.length, sent: R.traffic.length, delivered: R.deliveries.length, verified: R.deliveries.filter((d) => d.ok).length, stats: R.stats, problems: R.problems.slice(0, 10) };
let hardySigned = 0, jsSigned = 0;
const signersByBundle = [];
for (const d of R.deliveries) {
  const items = readBlockItems(decodeBundle(Buffer.from(d.data, "hex"))).items.map(receiptFields);
  for (const f of items) (hardyEids.has(f.thisHop) ? hardySigned++ : jsSigned++);
  signersByBundle.push({ label: d.label, ok: d.ok, reason: d.reason, signers: items.map((f) => f.thisHop), gaps: d.gaps, latencyScenarioH: +(((d.delivered - d.sent) * P.scale) / H).toFixed(2) });
}
out.receipts = { byHardy: hardySigned, byJsEndpoints: jsSigned };
out.unsignedGaps = R.deliveries.flatMap((d) => d.gaps || []).length;
out.bundles = signersByBundle;
out.revocationHeardBy = R.heard;

// Clearing: the ground's keyring (all records, the revocation as published).
const anchors = Object.entries(P.ops).map(([op, k]) => ({ name: op, pub: keyFromSeed(k.root).pub }));
const ring = new Keyring({ anchors });
for (const h of P.records) ring.add(decode(Buffer.from(h, "hex")), R.theft - DTN_EPOCH - 864e5);
try { ring.add(decode(Buffer.from(readFileSync(`${dir}/revocation.hex`, "utf8"), "hex")), R.detect - DTN_EPOCH); } catch {}
const delivered = new Set(R.deliveries.map((d) => JSON.stringify(bundleIdentity(decodeBundle(Buffer.from(d.data, "hex"))))));
const claims = R.deliveries.map((d) => ({ data: Buffer.from(d.data, "hex"), arrivedAt: d.delivered - DTN_EPOCH, source: "delivery", note: d.label }));
// The thief bills with the stolen relay key for carriage it never did.
const stolen = { kp: keyFromSeed(P.seeds[R.victim]), eid: R.victim };
const notVia = R.deliveries.filter((d) => !readBlockItems(decodeBundle(Buffer.from(d.data, "hex"))).items.some((it) => receiptFields(it).thisHop === R.victim));
const end = Date.now() - DTN_EPOCH;
if (notVia.length >= 2) {
  const forge = (d, t) => stampBundleV2(Buffer.from(d.data, "hex"), stolen, { prevHop: d.at, receivedAt: t, forwardedAt: t + 1000, chain: true });
  claims.push({ data: forge(notVia[0], R.theft - DTN_EPOCH - 60000), arrivedAt: end, source: "submitted", note: "forged: appended, backdated before the theft" });
  claims.push({ data: forge(notVia[1], R.theft - DTN_EPOCH + 60000), arrivedAt: end, source: "submitted", note: "forged: signed after the theft" });
}
const c = clear({ claims, keyring: ring, delivered, clearingKey: keyFromSeed(P.seeds["ipn:1.0"]), period: { scale: P.scale }, opOf });
out.forgeries = claims.filter((x) => x.source === "submitted").map((x) => ({ claim: x.note, outcome: c.rejected.filter((r) => r.claim === x.note).map((r) => r.reason).join(", ") || "accepted (BUG)" }));
out.settlement = Object.fromEntries(Object.entries(c.perOp).filter(([op]) => op !== "science").map(([op, s]) => [op, { bundles: s.bundles, amount: +s.amount.toFixed(4), refused: s.rejected }]));
out.honestLossAfterTheft = c.rejected.filter((r) => r.hop === R.victim && !String(r.claim).startsWith("forged")).length;

out.ok = out.delivered === out.sent && out.problems.length === 0 && out.receipts.byHardy > 0
  && out.forgeries.every((f) => !f.outcome.includes("BUG"))
  && R.deliveries.every((d) => d.ok || d.reason === "signed_after_revocation");
writeFileSync(`${dir}/report.json`, JSON.stringify(out, null, 1));
if (process.argv.includes("--json")) console.log("SSI_HARDY_RESULT " + JSON.stringify(out));
else {
  console.log(`[report] delivered ${out.delivered}/${out.sent}, chains verified ${out.verified}; receipts signed by Hardy ${hardySigned}, by JS endpoints ${jsSigned}; forwards ${out.stats.forwards}, held by link ${out.stats.heldByLink}`);
  for (const b of out.bundles) console.log(`  ${b.label.padEnd(18)} ${b.ok ? "verified" : "REFUSED " + b.reason}  signers ${b.signers.join(" > ")}${b.gaps?.length ? `  gap: last unsigned ${b.gaps[0].lastUnsigned ?? "?"}${b.gaps[0].unsignedNodes !== undefined ? `, ${b.gaps[0].unsignedNodes} node(s)` : ""}` : ""}  (${b.latencyScenarioH} h)`);
  for (const f of out.forgeries) console.log(`  ${f.claim}: ${f.outcome}`);
  console.log(`  settlement ${JSON.stringify(out.settlement)}; honest receipts lost after the theft: ${out.honestLossAfterTheft}`);
  if (out.problems.length) console.log(`  problems: ${out.problems.join(" | ")}`);
  console.log(`SSI_HARDY_RESULT ${JSON.stringify({ ok: out.ok, delivered: out.delivered, sent: out.sent, verified: out.verified, receipts: out.receipts })}`);
}
process.exit(out.ok ? 0 : 1);
