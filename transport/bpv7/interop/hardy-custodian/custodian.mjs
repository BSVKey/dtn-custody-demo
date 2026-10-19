// Two-way interop between the Hardy custodian filter (hardy-custody-receipt, an Egress
// Rewriter inside Aalyria's Hardy BPA) and our JS reference for custody receipt version 2
// (receipt-v2.mjs). Run by run.sh inside the dtn-custody-hardy-custodian image.
//
//   node custodian.mjs keys <dir>   fresh Ed25519 keys: Hardy's seed file and both public keys
//   node custodian.mjs make <dir>   A: a plain bundle (no block 224); B: the same kind of
//                                   bundle with one receipt signed by the JS custodian ipn:1.0
//   node custodian.mjs cla <dir>    dispatch A and B into Hardy over its gRPC CLA API as from
//                                   peer ipn:1.0, catch what Hardy forwards to peer ipn:30.0
//   node custodian.mjs check <dir>  verify both directions with verifyBundleV2
import fs from "node:fs";
import path from "node:path";
import { generateKeyPairSync, createPrivateKey, createPublicKey } from "node:crypto";
import { createRequire } from "node:module";
import { encodeBundle, decodeBundle, BLOCK, BLOCK_FLAG, CRC32C } from "../../bundle.mjs";
import { encode } from "../../cbor.mjs";
import { CUSTODY_BLOCK_TYPE } from "../../custody-block.mjs";
import { stampBundleV2, verifyBundleV2, readBlockItems, receiptFields, payloadHash } from "../../receipt-v2.mjs";

const [mode, dir] = process.argv.slice(2);
const f = (n) => path.join(dir, n);
const hex = (n) => Buffer.from(fs.readFileSync(f(n), "utf8").trim(), "hex");
const DTN_EPOCH = Date.UTC(2000, 0, 1);
const DTN_NOW = () => Date.now() - DTN_EPOCH;
const SRC = "ipn:1.1", DST = "ipn:30.1", JS = "ipn:1.0", HARDY = "ipn:20.0", JS_DOWN = "ipn:30.0";
const log = (m) => console.log(`[custodian] ${m}`);

function keyFromSeed(seedHex) {
  const priv = createPrivateKey({ key: Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), Buffer.from(seedHex, "hex")]), format: "der", type: "pkcs8" });
  return { priv, pub: createPublicKey(priv).export({ type: "spki", format: "der" }).toString("base64") };
}
function freshSeed() {
  const { privateKey } = generateKeyPairSync("ed25519");
  return privateKey.export({ format: "der", type: "pkcs8" }).subarray(-32).toString("hex");
}

function plainBundle(seq, text) {
  return encodeBundle({
    primary: { crcType: CRC32C, dest: DST, source: SRC, created: [DTN_NOW(), seq], lifetime: 3600000 },
    blocks: [{ type: BLOCK.PAYLOAD, number: 1, crcType: CRC32C, data: Buffer.from(text.repeat(40)) }],
  });
}

if (mode === "keys") {
  const keys = { hardy: freshSeed(), js: freshSeed(), jsDown: freshSeed() };
  fs.writeFileSync(f("hardy.seed"), keys.hardy + "\n", { mode: 0o600 });
  fs.writeFileSync(f("keys.json"), JSON.stringify(keys));
  log(`fresh keys: Hardy custodian ${HARDY} ${keyFromSeed(keys.hardy).pub}`);
} else if (mode === "make") {
  const keys = JSON.parse(fs.readFileSync(f("keys.json"), "utf8"));
  fs.writeFileSync(f("a.in"), plainBundle(1, "Hardy signs first. ").toString("hex"));
  const b = stampBundleV2(plainBundle(2, "JS signs first. "), { kp: keyFromSeed(keys.js), eid: JS }, { prevHop: SRC, receivedAt: DTN_NOW(), forwardedAt: DTN_NOW() });
  fs.writeFileSync(f("b.in"), b.toString("hex"));
  log(`A: plain bundle, ${hex("a.in").length} bytes, no block 224`);
  log(`B: one receipt signed by the JS custodian ${JS}, ${b.length} bytes`);
} else if (mode === "cla") {
  const require = createRequire("/opt/grpc/");
  const grpc = require("@grpc/grpc-js");
  const loader = require("@grpc/proto-loader");
  const { cla } = grpc.loadPackageDefinition(loader.loadSync("cla.proto", {
    includeDirs: ["/app/hardy/proto"], keepCase: true, longs: Number, enums: String, defaults: true, oneofs: true,
  }));
  const fail = (m) => { log(m); process.exit(1); };
  setTimeout(() => fail("Hardy did not forward both bundles in time"), 30000);
  const want = { 1: "a.out", 2: "b.out" };
  let done = 0;
  const s = new cla.Cla(process.env.BPA || "[::1]:50051", grpc.credentials.createInsecure()).Register();
  s.write({ msg_id: 1, register: { name: "custodian-interop-cla", address_type: "CLA_ADDRESS_TYPE_PRIVATE" } });
  s.on("data", (m) => {
    if (m.register) {
      s.write({ msg_id: 2, add_peer: { node_ids: [JS_DOWN], address: { address_type: "CLA_ADDRESS_TYPE_PRIVATE", address: Buffer.from("custody-rx") } } });
    } else if (m.add_peer) {
      if (!m.add_peer.added) fail(`peer ${JS_DOWN} not added`);
      s.write({ msg_id: 3, dispatch: { bundle: hex("a.in"), peer_node_id: JS } });
      s.write({ msg_id: 4, dispatch: { bundle: hex("b.in"), peer_node_id: JS } });
      log(`dispatched A and B into Hardy as from peer ${JS}`);
    } else if (m.dispatch) {
      if (m.dispatch.verdict !== "DISPATCH_VERDICT_ACCEPTED") fail(`Hardy refused a bundle: ${m.dispatch.verdict}`);
    } else if (m.forward) {
      const bytes = Buffer.from(m.forward.bundle);
      const seq = decodeBundle(bytes).primary.created[1];
      fs.writeFileSync(f(want[seq]), bytes.toString("hex"));
      s.write({ msg_id: m.msg_id, forward: { sent: {} } });
      log(`Hardy forwarded ${want[seq] === "a.out" ? "A" : "B"} (${bytes.length} bytes) to peer ${JS_DOWN}`);
      if (++done === 2) setTimeout(() => process.exit(0), 200);
    } else if (m.status && m.status.code) {
      log(`BPA status ${m.status.code}: ${m.status.message}`);
    }
  });
  s.on("error", (e) => fail(`stream error: ${e.message}`));
} else if (mode === "check") {
  const keys = JSON.parse(fs.readFileSync(f("keys.json"), "utf8"));
  const pub = { [JS]: keyFromSeed(keys.js).pub, [HARDY]: keyFromSeed(keys.hardy).pub, [JS_DOWN]: keyFromSeed(keys.jsDown).pub };
  const results = [];
  const expect = (name, ok, detail) => { results.push(ok); log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? `: ${detail}` : ""}`); };
  const crb = (b) => b.blocks.filter((x) => x.type === CUSTODY_BLOCK_TYPE);
  const types = (b) => b.blocks.map((x) => x.type).join(",");
  const untouched = (sent, got) => sent.blocks.filter((x) => x.type !== CUSTODY_BLOCK_TYPE).every((x) => {
    const y = got.blocks.find((z) => z.number === x.number);
    return y && y.type === x.type && y.flags === x.flags && y.data.equals(x.data);
  });
  const recent = (t) => Number.isInteger(t) && Math.abs(DTN_NOW() - t) < 120000;

  // A: Hardy is the first custodian. It adds block 224 with one receipt.
  const aIn = decodeBundle(hex("a.in")), aOutBytes = hex("a.out"), aOut = decodeBundle(aOutBytes);
  log(`A: sent blocks [${types(aIn)}], forwarded by Hardy [${types(aOut)}]`);
  const aBlock = crb(aOut);
  expect("A: Hardy added exactly one Custody Receipt Block", aBlock.length === 1);
  expect("A: block flags are replicate-in-every-fragment only, CRC-32C (draft 4.2)",
    aBlock[0]?.flags === BLOCK_FLAG.REPLICATE_IN_FRAGMENTS && aBlock[0]?.crcType === CRC32C, `flags ${aBlock[0]?.flags}, crc ${aBlock[0]?.crcType}`);
  expect("A: payload and every other sent block unchanged", untouched(aIn, aOut));
  const aV = verifyBundleV2(aOutBytes, { keys: pub, origin: JS });
  expect("A: verifyBundleV2 (JS) accepts Hardy's receipt", aV.ok && aV.custodied === 1, JSON.stringify(aV));
  const aF = receiptFields(readBlockItems(aOut).items[0]);
  expect("A: receipt names thisHop ipn:20.0, prevHop the ingress peer ipn:1.0, this payload's hash",
    aF.thisHop === HARDY && aF.prevHop === JS && aF.payloadHash.equals(payloadHash(aIn)));
  expect("A: receivedAt <= forwardedAt, both current DTN time", recent(aF.receivedAt) && recent(aF.forwardedAt) && aF.receivedAt <= aF.forwardedAt,
    `receivedAt ${aF.receivedAt}, forwardedAt ${aF.forwardedAt}`);
  expect("A: chain complete (Hardy's Previous Node is the last receipt's thisHop)", aV.ok && aV.complete);

  // B: the JS custodian signed first; Hardy keeps that receipt and appends its own.
  const bInBytes = hex("b.in"), bIn = decodeBundle(bInBytes), bOutBytes = hex("b.out"), bOut = decodeBundle(bOutBytes);
  log(`B: sent blocks [${types(bIn)}], forwarded by Hardy [${types(bOut)}]`);
  const before = readBlockItems(bIn).items, after = readBlockItems(bOut).items;
  expect("B: still one Custody Receipt Block, same block number and flags",
    crb(bOut).length === 1 && crb(bOut)[0].number === crb(bIn)[0].number && crb(bOut)[0].flags === crb(bIn)[0].flags);
  expect("B: Hardy appended one receipt (1 -> 2)", before.length === 1 && after.length === 2);
  expect("B: the JS receipt is byte-identical after Hardy", encode(after[0]).equals(encode(before[0])));
  expect("B: payload and every other sent block unchanged", untouched(bIn, bOut));
  const bV = verifyBundleV2(bOutBytes, { keys: pub, origin: SRC, hops: [JS, HARDY] });
  expect("B: verifyBundleV2 (JS) accepts both receipts on the pinned route [ipn:1.0, ipn:20.0]", bV.ok && bV.custodied === 2 && bV.complete, JSON.stringify(bV));

  // C: a JS custodian downstream of Hardy appends a third: JS -> Hardy -> JS.
  const cBytes = stampBundleV2(bOutBytes, { kp: keyFromSeed(keys.jsDown), eid: JS_DOWN }, { receivedAt: DTN_NOW(), forwardedAt: DTN_NOW() });
  const cV = verifyBundleV2(cBytes, { keys: pub, origin: SRC, hops: [JS, HARDY, JS_DOWN], lastNode: JS_DOWN });
  expect("C: a JS custodian after Hardy appends a third; route [ipn:1.0, ipn:20.0, ipn:30.0] complete", cV.ok && cV.custodied === 3 && cV.complete, JSON.stringify(cV));

  // Controls: the check can fail.
  const wrong = verifyBundleV2(aOutBytes, { keys: { ...pub, [HARDY]: pub[JS] }, origin: JS });
  expect("control: Hardy's receipt under the wrong pinned key is refused", !wrong.ok && wrong.reason === "signature_invalid", wrong.reason);
  const tampered = decodeBundle(bOutBytes);
  const pl = tampered.blocks.find((x) => x.type === BLOCK.PAYLOAD);
  pl.data = Buffer.from(pl.data); pl.data[0] ^= 1;
  const tV = verifyBundleV2(encodeBundle(tampered), { keys: pub, origin: SRC });
  expect("control: one flipped payload bit is refused", !tV.ok && tV.reason === "payload_hash_mismatch", tV.reason);

  const sizes = `A ${hex("a.in").length} -> ${aOutBytes.length} bytes, B ${bInBytes.length} -> ${bOutBytes.length} bytes`;
  const receipt = encode(readBlockItems(aOut).items[0]).length;
  log(`${sizes}; one Hardy receipt is ${receipt} bytes`);
  const ok = results.every(Boolean);
  log(`${results.filter(Boolean).length} of ${results.length} checks pass`);
  process.exit(ok ? 0 : 1);
} else {
  console.error("usage: node custodian.mjs keys|make|cla|check <dir>");
  process.exit(2);
}
