// The public entry point and the quickstart a new integrator copies first: both must
// keep working, so the documented path never drifts from the code.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import * as api from "../index.mjs";

test("index.mjs exports the documented API", () => {
  for (const name of ["genKeypair", "exportKeypair", "importKeypair", "prepare", "makeRelay", "makeDest",
    "verifyCustodyChain", "auditCustodyChain", "bindDelivery", "batchReceipt", "verifyPath", "gapObject"]) {
    assert.equal(typeof api[name], "function", `${name} is exported`);
  }
});

test("examples/quickstart.mjs runs and every check passes", () => {
  const out = execFileSync(process.execPath, [fileURLToPath(new URL("../examples/quickstart.mjs", import.meta.url))], { encoding: "utf8" });
  assert.match(out, /custody chains:\s+all intact/);
  assert.match(out, /payload intact:\s+true/);
  assert.match(out, /delivery bound:\s+true/);
});

test("quickstart path refuses a forged hop and a foreign settlement", () => {
  const src = api.genKeypair(), a = api.genKeypair(), d = api.genKeypair(), impostor = api.genKeypair();
  const { manifest, bundles } = api.prepare(src, Buffer.from("x".repeat(600)), { payloadId: "p", chunkSize: 256 });
  const rx = api.makeDest(d, manifest, [{ eid: "dtn://a/", pub: a.pub }], { sourcePub: src.pub });
  const b = bundles[0];
  assert.equal(rx.receiveBundle(b).ok, true);
  rx.recordCustody(b.bundleId, api.makeRelay(impostor, "dtn://a/").stamp(b, "dtn://src/", 0, 1));
  assert.equal(rx.verifyChain(b.bundleId).reason, "signer_not_pinned_hop_key");
  const mine = "0x" + "1".repeat(64);
  assert.equal(rx.settle(d, { settlementRef: mine }, { settlementRef: "0x" + "2".repeat(64) }).bind.reason, "settlementRef_not_mine");
});
