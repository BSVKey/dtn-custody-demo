// Two-way interop between the Hardy custodian filter (hardy-custody-receipt, an Egress
// Rewriter inside Aalyria's Hardy BPA) and our JS reference for custody receipt version 2
// (receipt-v2.mjs). Run by run.sh inside the dtn-custody-hardy-custodian image.
//
//   node custodian.mjs keys <dir>          fresh Ed25519 keys (Hardy's seed file) and an AES key for BCBs
//   node custodian.mjs make <dir>          A: plain; B: one JS receipt; D1..D3: fragments of a
//                                          JS-stamped bundle; E1/E2: for policy block-present;
//                                          f/g .plain.bin: for run.sh to encrypt with Hardy's tool
//   node custodian.mjs make-bcb <dir>      F: payload under a BCB; G: the same with a JS receipt
//   node custodian.mjs cla <dir> <name>... dispatch <name>.in into Hardy over its gRPC CLA API as
//                                          from peer ipn:1.0, catch <name>.out forwarded to ipn:30.0
//   node custodian.mjs check <dir> <bcbLogLines>   policy always: A, B, C, D, F, G
//   node custodian.mjs check-policy <dir>  policy block-present: E1, E2
import fs from "node:fs";
import path from "node:path";
import { generateKeyPairSync, createPrivateKey, createPublicKey, randomBytes } from "node:crypto";
import { createRequire } from "node:module";
import { encodeBundle, decodeBundle, BLOCK, BLOCK_FLAG, BUNDLE_FLAG, CRC32C } from "../../bundle.mjs";
import { encode } from "../../cbor.mjs";
import { CUSTODY_BLOCK_TYPE } from "../../custody-block.mjs";
import { stampBundleV2, verifyBundleV2, readBlockItems, receiptFields, payloadHash } from "../../receipt-v2.mjs";

const [mode, dir, ...rest] = process.argv.slice(2);
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
const stampJs = (bytes, keys) => stampBundleV2(bytes, { kp: keyFromSeed(keys.js), eid: JS }, { prevHop: SRC, receivedAt: DTN_NOW(), forwardedAt: DTN_NOW() });
const writeHex = (n, b) => fs.writeFileSync(f(n), Buffer.from(b).toString("hex"));
// The forwarded copy is matched to its input by sequence number and fragment offset.
const keyOf = (b) => `${b.primary.created[1]}:${b.primary.fragmentOffset ?? ""}`;
const FRAGMENTS = 3;

if (mode === "keys") {
  const keys = { hardy: freshSeed(), js: freshSeed(), jsDown: freshSeed() };
  fs.writeFileSync(f("hardy.seed"), keys.hardy + "\n", { mode: 0o600 });
  fs.writeFileSync(f("keys.json"), JSON.stringify(keys));
  // A fresh AES-256 key for BCB-AES-GCM, held only by the sender: Hardy has no key for it.
  fs.writeFileSync(f("bcb-keys.json"), JSON.stringify({ keys: [{ kty: "oct", kid: "bcb", alg: "dir", enc: "A256GCM", key_ops: ["encrypt", "decrypt"], k: randomBytes(32).toString("base64url") }] }));
  log(`fresh keys: Hardy custodian ${HARDY} ${keyFromSeed(keys.hardy).pub}`);
} else if (mode === "make") {
  const keys = JSON.parse(fs.readFileSync(f("keys.json"), "utf8"));
  writeHex("a.in", plainBundle(1, "Hardy signs first. "));
  const b = stampJs(plainBundle(2, "JS signs first. "), keys);
  writeHex("b.in", b);
  log(`A: plain bundle, ${hex("a.in").length} bytes, no block 224`);
  log(`B: one receipt signed by the JS custodian ${JS}, ${b.length} bytes`);

  // D: a whole bundle stamped by the JS custodian, then fragmented the RFC 9171 5.8 way:
  // the payload split, block 224 (replicate in every fragment) copied into each fragment.
  const whole = decodeBundle(stampJs(plainBundle(3, "Fragmented through Hardy. "), keys));
  const adu = whole.blocks.find((x) => x.type === BLOCK.PAYLOAD).data;
  const size = Math.ceil(adu.length / FRAGMENTS);
  for (let i = 0; i < FRAGMENTS; i++) {
    const frag = {
      primary: { ...whole.primary, flags: (whole.primary.flags ?? 0) | BUNDLE_FLAG.IS_FRAGMENT, fragmentOffset: i * size, totalAduLength: adu.length },
      blocks: whole.blocks.map((x) => (x.type === BLOCK.PAYLOAD ? { ...x, data: adu.subarray(i * size, (i + 1) * size) } : x)),
    };
    writeHex(`d${i + 1}.in`, encodeBundle(frag));
  }
  log(`D: a ${adu.length}-byte ADU with one JS whole-bundle receipt, split into ${FRAGMENTS} fragments, block 224 in each`);

  // E: for the block-present policy run. E1 has no block 224, E2 one JS receipt.
  writeHex("e1.in", plainBundle(6, "Not marked for custody. "));
  writeHex("e2.in", stampJs(plainBundle(7, "Marked for custody. "), keys));
  log("E1: plain, E2: one JS receipt (for the block-present run)");

  // F and G: plaintext for Hardy's own bundle tool to encrypt (run.sh).
  fs.writeFileSync(f("f.plain.bin"), plainBundle(4, "Encrypted payload, no receipt yet. "));
  fs.writeFileSync(f("g.plain.bin"), plainBundle(5, "Encrypted payload, JS receipt over the ciphertext. "));
} else if (mode === "make-bcb") {
  const keys = JSON.parse(fs.readFileSync(f("keys.json"), "utf8"));
  const fBytes = fs.readFileSync(f("f.bcb.bin")), gBytes = fs.readFileSync(f("g.bcb.bin"));
  const show = (x) => decodeBundle(x).blocks.map((k) => k.type).join(",");
  writeHex("f.in", fBytes);
  // The JS custodian hashes the payload block's data as held: here the ciphertext.
  writeHex("g.in", stampJs(gBytes, keys));
  log(`F: payload encrypted by Hardy's bundle tool (BCB-AES-GCM, A256GCM, key not given to the BPA), blocks [${show(fBytes)}]`);
  log(`G: the same kind of bundle with one JS receipt over the ciphertext, blocks [${show(hex("g.in"))}]`);
} else if (mode === "cla") {
  const require = createRequire("/opt/grpc/");
  const grpc = require("@grpc/grpc-js");
  const loader = require("@grpc/proto-loader");
  const { cla } = grpc.loadPackageDefinition(loader.loadSync("cla.proto", {
    includeDirs: ["/app/hardy/proto"], keepCase: true, longs: Number, enums: String, defaults: true, oneofs: true,
  }));
  const fail = (m) => { log(m); process.exit(1); };
  const names = rest;
  const want = Object.fromEntries(names.map((n) => [keyOf(decodeBundle(hex(`${n}.in`))), n]));
  setTimeout(() => fail(`Hardy did not forward all of ${names.join(", ")} in time`), 30000);
  let done = 0, id = 10;
  const s = new cla.Cla(process.env.BPA || "[::1]:50051", grpc.credentials.createInsecure()).Register();
  s.write({ msg_id: 1, register: { name: "custodian-interop-cla", address_type: "CLA_ADDRESS_TYPE_PRIVATE" } });
  s.on("data", (m) => {
    if (m.register) {
      s.write({ msg_id: 2, add_peer: { node_ids: [JS_DOWN], address: { address_type: "CLA_ADDRESS_TYPE_PRIVATE", address: Buffer.from("custody-rx") } } });
    } else if (m.add_peer) {
      if (!m.add_peer.added) fail(`peer ${JS_DOWN} not added`);
      for (const n of names) s.write({ msg_id: id++, dispatch: { bundle: hex(`${n}.in`), peer_node_id: JS } });
      log(`dispatched ${names.join(", ")} into Hardy as from peer ${JS}`);
    } else if (m.dispatch) {
      if (m.dispatch.verdict !== "DISPATCH_VERDICT_ACCEPTED") fail(`Hardy refused a bundle: ${m.dispatch.verdict}`);
    } else if (m.forward) {
      const bytes = Buffer.from(m.forward.bundle);
      const n = want[keyOf(decodeBundle(bytes))];
      if (!n) fail("Hardy forwarded a bundle we did not send");
      writeHex(`${n}.out`, bytes);
      s.write({ msg_id: m.msg_id, forward: { sent: {} } });
      log(`Hardy forwarded ${n.toUpperCase()} (${bytes.length} bytes) to peer ${JS_DOWN}`);
      if (++done === names.length) setTimeout(() => process.exit(0), 200);
    } else if (m.status && m.status.code) {
      log(`BPA status ${m.status.code}: ${m.status.message}`);
    }
  });
  s.on("error", (e) => fail(`stream error: ${e.message}`));
} else if (mode === "check" || mode === "check-policy") {
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

  const finish = () => {
    const ok = results.every(Boolean);
    log(`${results.filter(Boolean).length} of ${results.length} checks pass`);
    process.exit(ok ? 0 : 1);
  };

  if (mode === "check-policy") {
    // policy: block-present. E1 has no block 224 and must leave unsigned; E2 must gain a receipt.
    const e1In = decodeBundle(hex("e1.in")), e1Out = decodeBundle(hex("e1.out"));
    log(`E1: sent blocks [${types(e1In)}], forwarded by Hardy [${types(e1Out)}]`);
    expect("E1 (block-present): no block 224 added to a bundle without one", crb(e1Out).length === 0);
    expect("E1: payload and every other sent block unchanged", untouched(e1In, e1Out));
    const e2In = decodeBundle(hex("e2.in")), e2OutBytes = hex("e2.out"), e2Out = decodeBundle(e2OutBytes);
    log(`E2: sent blocks [${types(e2In)}], forwarded by Hardy [${types(e2Out)}]`);
    const e2Before = readBlockItems(e2In).items, e2After = readBlockItems(e2Out).items;
    expect("E2 (block-present): Hardy appended to the block already there (1 -> 2), JS receipt byte-identical",
      e2Before.length === 1 && e2After.length === 2 && encode(e2After[0]).equals(encode(e2Before[0])));
    const e2V = verifyBundleV2(e2OutBytes, { keys: pub, origin: SRC, hops: [JS, HARDY] });
    expect("E2: verifyBundleV2 on the pinned route [ipn:1.0, ipn:20.0]", e2V.ok && e2V.complete && e2V.custodied === 2, JSON.stringify(e2V));
    finish();
  }

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

  // D: fragments. Each must carry block 224 (replicated), keep the JS whole-bundle
  // receipt, and gain a Hardy receipt naming the fragment and its payload slice.
  for (let i = 1; i <= FRAGMENTS; i++) {
    const dIn = decodeBundle(hex(`d${i}.in`)), dOutBytes = hex(`d${i}.out`), dOut = decodeBundle(dOutBytes);
    const p = dOut.primary, label = `D${i} (offset ${p.fragmentOffset} of ${p.totalAduLength})`;
    const blk = crb(dOut), items = readBlockItems(dOut).items;
    expect(`${label}: still a fragment, block 224 present with replicate-in-every-fragment set`,
      (p.flags & BUNDLE_FLAG.IS_FRAGMENT) !== 0 && blk.length === 1 && (blk[0].flags & BLOCK_FLAG.REPLICATE_IN_FRAGMENTS) !== 0);
    let hf = {};
    try { hf = receiptFields(items[1]); } catch { /* reported below */ }
    expect(`${label}: Hardy's receipt names [source, [time, seq], offset, total] and this fragment's payload hash`,
      items.length === 2 && JSON.stringify(hf.bundle) === JSON.stringify([SRC, p.created, p.fragmentOffset, p.totalAduLength])
        && Buffer.isBuffer(hf.payloadHash) && hf.payloadHash.equals(payloadHash(dIn)),
      JSON.stringify(hf.bundle));
    expect(`${label}: JS whole-bundle receipt byte-identical`, encode(items[0]).equals(encode(readBlockItems(dIn).items[0])));
    const dV = verifyBundleV2(dOutBytes, { keys: pub, origin: SRC, hops: [JS, HARDY] });
    expect(`${label}: verifyBundleV2 ok and complete; Hardy's receipt hash-checked, the whole-bundle one listed unchecked`,
      dV.ok && dV.complete && dV.custodied === 2 && JSON.stringify(dV.hashUnchecked) === "[0]", JSON.stringify(dV));
  }

  // F and G: payload under a BCB. The filter cannot read the ciphertext, so it signs nothing.
  const bcbLines = Number(rest[0] ?? 0);
  const fIn = decodeBundle(hex("f.in")), fOut = decodeBundle(hex("f.out"));
  log(`F: sent blocks [${types(fIn)}], forwarded by Hardy [${types(fOut)}]`);
  expect("F (BCB payload): no block 224 added; BCB and ciphertext unchanged", crb(fOut).length === 0 && untouched(fIn, fOut));
  const gIn = decodeBundle(hex("g.in")), gOutBytes = hex("g.out"), gOut = decodeBundle(gOutBytes);
  log(`G: sent blocks [${types(gIn)}], forwarded by Hardy [${types(gOut)}]`);
  expect("G (BCB payload, JS receipt): block 224 byte-identical, no Hardy receipt",
    crb(gOut).length === 1 && crb(gOut)[0].data.equals(crb(gIn)[0].data) && untouched(gIn, gOut));
  const gV = verifyBundleV2(gOutBytes, { keys: pub, origin: SRC });
  expect("G: the JS receipt over the ciphertext verifies; the audit names Hardy as the unsigned last node",
    gV.ok && gV.custodied === 1 && gV.gaps.length === 1 && gV.gaps[0].lastUnsigned === HARDY, JSON.stringify(gV));
  expect("F, G: Hardy logged why it did not sign, once per bundle", bcbLines === 2, `${bcbLines} log lines`);

  const sizes = `A ${hex("a.in").length} -> ${aOutBytes.length} bytes, B ${bInBytes.length} -> ${bOutBytes.length} bytes`;
  const receipt = encode(readBlockItems(aOut).items[0]).length;
  log(`${sizes}; one Hardy receipt is ${receipt} bytes`);
  finish();
} else {
  console.error("usage: node custodian.mjs keys|make|make-bcb|cla|check|check-policy <dir> ...");
  process.exit(2);
}
