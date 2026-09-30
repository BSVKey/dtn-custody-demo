import { test } from "node:test";
import assert from "node:assert/strict";
import { genKeypair } from "../agent/lib/keys.mjs";
import { signRecord } from "../agent/lib/receipt.mjs";
import { buildLedger, verifyLedger, corroborate, fingerprint } from "../ground/lib.mjs";

const T0 = Date.parse("2026-10-01T00:00:00Z");
const passes = [
  { passId: "P1", start: T0, end: T0 + 600_000 },
  { passId: "P2", start: T0 + 6_000_000, end: T0 + 6_600_000 },
];
const f = (name, n, t) => ({ name, bytes: Buffer.alloc(n, name.length), receivedAt: t });
const files = [f("a.bin", 200_000, T0 + 60_000), f("b.bin", 10, T0 + 120_000), f("late.bin", 5, T0 + 9_000_000)];
const station = "ipn:20.0", spacecraft = "ipn:5.0";

test("ledger verifies under the pinned station key and re-hashes products", () => {
  const kp = genKeypair();
  const L = buildLedger(kp, { station, spacecraft, files, passes });
  const v = verifyLedger(L, { stationPub: kp.pub, files: new Map(files.map((x) => [x.name, x.bytes])) });
  assert.equal(v.ok, true);
  assert.equal(v.products, 3);
  assert.equal(v.productsRehashed, 3);
  assert.equal(v.silentPasses, 1);
});

test("a silent pass becomes a gap that ends when data next arrived", () => {
  const kp = genKeypair();
  const L = buildLedger(kp, { station, spacecraft, files, passes });
  const p2 = L.records.find((r) => r.kind === "station.pass/1" && r.passId === "P2");
  assert.equal(p2.status, "no-data");
  assert.equal(p2.gap.kind, "gap/1");
  assert.equal(p2.gap.downAt, passes[1].start);
  assert.equal(p2.gap.upAt, T0 + 9_000_000);
  const un = L.records.find((r) => r.kind === "station.unscheduled/1");
  assert.deepEqual(un.products.map((p) => p.name), ["late.bin"]);
});

test("verification refuses an unpinned or wrong key, altered products and edited records", () => {
  const kp = genKeypair();
  const L = buildLedger(kp, { station, spacecraft, files, passes });
  assert.equal(verifyLedger(L, {}).ok, false);
  assert.equal(verifyLedger(L, { stationPub: genKeypair().pub }).reason, "signer_not_pinned_station_key");
  const bad = new Map(files.map((x) => [x.name, x.bytes]));
  bad.set("a.bin", Buffer.concat([files[0].bytes, Buffer.from([1])]));
  assert.equal(verifyLedger(L, { stationPub: kp.pub, files: bad }).reason, "product_altered");
  const edited = structuredClone(L);
  edited.records.find((r) => r.kind === "station.pass/1").products = 99;
  assert.equal(verifyLedger(edited, { stationPub: kp.pub }).reason, "claimId_mismatch");
});

test("dropping or re-signing a record breaks the seal", () => {
  const kp = genKeypair();
  const L = buildLedger(kp, { station, spacecraft, files, passes });
  const dropped = structuredClone(L);
  dropped.records.pop();
  assert.equal(verifyLedger(dropped, { stationPub: kp.pub }).reason, "seal_mismatch");
  const swapped = structuredClone(L);
  const i = swapped.records.findIndex((r) => r.kind === "station.pass/1");
  const { claimId, sig, signerPub, ...content } = swapped.records[i];
  swapped.records[i] = signRecord(kp, { ...content, products: content.products + 1 });
  assert.equal(verifyLedger(swapped, { stationPub: kp.pub }).reason, "seal_mismatch");
});

test("two stations corroborate identical products", () => {
  const A = buildLedger(genKeypair(), { station, spacecraft, files: files.slice(0, 2), passes });
  const B = buildLedger(genKeypair(), { station: "ipn:21.0", spacecraft, files, passes });
  const c = corroborate(A, B);
  assert.equal(c.corroborated.length, 2);
  assert.deepEqual(c.onlyB, ["late.bin"]);
  assert.equal(fingerprint(files[0].bytes).chunkCount, 4);
});

test("pass comparison locates a one-sided gap and clears a shared silence", async () => {
  const { comparePasses } = await import("../ground/lib.mjs");
  const p3 = [...passes, { passId: "P3", start: T0 + 12_000_000, end: T0 + 12_600_000 }];
  // A hears P1 only; B hears P1 and P2; neither hears P3.
  const A = buildLedger(genKeypair(), { station, spacecraft, files: files.slice(0, 2), passes: p3 });
  const B = buildLedger(genKeypair(), { station: "ipn:21.0", spacecraft, files: [...files.slice(0, 2), f("p2.bin", 50, T0 + 6_100_000)], passes: p3 });
  const byPass = Object.fromEntries(comparePasses(A, B).map((x) => [x.passA, x.finding]));
  assert.deepEqual(byPass, { P1: "both_received", P2: "gap_at_a", P3: "shared_silence" });
  const other = buildLedger(genKeypair(), { station: "ipn:22.0", spacecraft: "ipn:6.0", files, passes: p3 });
  assert.deepEqual(comparePasses(A, other), []);
});
