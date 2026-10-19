// Readable walk-through of the LunaNet-shaped run. `node lunar/run.mjs`
import { lunanetRun, LINKS, lightMs, EID, ORBIT_RADIUS_KM } from "./lunanet.mjs";

const ok = (b) => (b ? "PASS" : "FAIL");
const r = lunanetRun();
console.log("\n== Route (LNIS v5 section 3.1.2: BPv7) ==");
console.log(`  ${EID.lander} lander (provider A, signs) -> ${EID.surface} surface relay (does not sign)`);
console.log(`  -> ${EID.orbiter} relay orbiter (provider B, signs, holds ${r.occultationMs / 60000} min far-side occultation)`);
console.log(`  -> ${EID.ground} Earth ground station (provider C, signs) -> ${EID.missionOps} mission ops`);
for (const l of Object.values(LINKS)) if (l.km) console.log(`  one-way light time ${lightMs(l.km).toFixed(1).padStart(7)} ms  ${l.label}`);
console.log(`  one-way light time ${r.trunkMs.toFixed(1).padStart(7)} ms  ${LINKS.trunk.label}: Moon ${Math.round(r.moonKm).toLocaleString("en-US")} km from Earth's centre`);

console.log("\n== Destination audit (block 224, receipt v2) ==");
console.log(`  receipts verify under pinned provider keys: ${ok(r.chain.ok)} (${r.chain.custodied} custodians)`);
for (const g of r.chain.gaps) console.log(`  unsigned stretch reported, not inferred: after ${g.afterHop}, last unsigned node ${g.lastUnsigned}, before ${g.beforeHop}`);
console.log(`  payload BIB (RFC 9173 HMAC-SHA2) still verifies after every append: ${ok(r.bib.ok)}`);

console.log("\n== Light-time audit ==");
for (const f of r.timing.findings) console.log(`  ${f.from} -> ${f.to}: received ${f.actualMs} ms after forward, light needs ${f.minMs} ms  ${ok(f.ok)}`);
const bad = lunanetRun({ backdateGroundMs: 900 });
console.log(`  floor = ephemeris distance less Earth's radius less the orbiter's ${ORBIT_RADIUS_KM.toFixed(0)} km orbit radius, over c`);
console.log(`  ground station backdates its receipt by 900 ms: signatures still verify (${ok(bad.chain.ok)}), timing audit catches it (${ok(!bad.timing.ok)})`);
console.log(`\n  bundle on arrival: ${r.receiptBytes} bytes, including three receipts\n`);
