// Live check helper for the uD3TN, HDTN, ION and Hardy runs (*-run.sh).
// Env: BUNDLE_SRC / BUNDLE_DST (primary block EIDs; HDTN, ION and Hardy route ipn:),
//      VIA (the unaware stack, for the log line), BPSEC=1 (add a full-scope RFC 9173
//      BIB-HMAC-SHA2 BIB over the payload at the source and verify it on arrival),
//      BIB_IPPT=ion (build the MAC input the way JPL ION does, see bpsec.mjs), BIB_SCOPE,
//      RECEIPT=2 (custody receipt version 2: COSE_Sign1, bound to the bundle identity and
//      payload bytes, receipt-v2.mjs; default version 1).
//   node live.mjs make <out.hex>            our gateway agent stamps hop 1, writes the bundle
//   node live.mjs check <in.hex> <out.hex>  after the unaware DTN stack: block intact? stamp hop 2, verify
import fs from "node:fs";
import { createPrivateKey, createPublicKey } from "node:crypto";
import { encodeBundle, decodeBundle, BLOCK, CRC32C } from "../bundle.mjs";
import { stampBundle, verifyBundleCustody, auditBundleCustody, previousNode, readCustody, CUSTODY_BLOCK_TYPE } from "../custody-block.mjs";
import { addBib, verifyBibs, SHA, IPPT_MODE } from "../bpsec.mjs";
import { stampBundleV2, verifyBundleV2 } from "../receipt-v2.mjs";
import { makeRelay } from "../../../agent/relay.mjs";
import { prepare } from "../../../agent/source.mjs";

// Public test seeds only (never for real use).
function testKey(seedHex) {
  const priv = createPrivateKey({ key: Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), Buffer.from(seedHex, "hex")]), format: "der", type: "pkcs8" });
  return { priv, pub: createPublicKey(priv).export({ type: "spki", format: "der" }).toString("base64") };
}
const UP = "dtn://gateway-up.dtn/", DOWN = "dtn://dest.dtn/";
const kUp = testKey("02".repeat(32)), kDown = testKey("03".repeat(32));
const hops = [{ eid: UP, pub: kUp.pub }, { eid: DOWN, pub: kDown.pub }];
const DTN_EPOCH = Date.UTC(2000, 0, 1);
const SRC = process.env.BUNDLE_SRC || "dtn://gateway-up.dtn/payload";
const DST = process.env.BUNDLE_DST || "dtn://dest.dtn/payload";
const VIA = process.env.VIA || "two unaware uD3TN nodes";
const BPSEC = process.env.BPSEC === "1";
// The RFC 9173 Appendix A example key: public, test only.
const BIB_KEY = Buffer.from(process.env.BIB_KEY_HEX || "1a2b1a2b1a2b1a2b1a2b1a2b1a2b1a2b", "hex");
const MODE = process.env.BIB_IPPT === "ion" ? IPPT_MODE.ION : IPPT_MODE.RFC9173;
const V2 = process.env.RECEIPT === "2";
const DTN_NOW = () => Date.now() - Date.UTC(2000, 0, 1);
const custodyBlock = (b) => b.blocks.find((x) => x.type === CUSTODY_BLOCK_TYPE);

const [mode, a, b] = process.argv.slice(2);
if (mode === "make") {
  const { bundles } = prepare(testKey("01".repeat(32)), Buffer.from("custody over real BPv7 ".repeat(100)), { chunkSize: 1024 });
  const c = bundles[0];
  let bundle = {
    primary: { crcType: CRC32C, dest: DST, source: SRC, created: [Date.now() - DTN_EPOCH, 1], lifetime: 3600000 },
    blocks: [{ type: BLOCK.PAYLOAD, number: 1, crcType: CRC32C, data: Buffer.from(JSON.stringify({ payloadId: c.payloadId, index: c.index, leafHex: c.leafHex, bytesB64: c.bytesB64, branch: c.branch })) }],
  };
  if (BPSEC) {
    bundle = addBib(bundle, { targets: [1], key: BIB_KEY, source: SRC, shaVariant: SHA.HMAC256, scope: Number(process.env.BIB_SCOPE ?? 7), mode: MODE });
    console.log(`[live] source added a BPSec BIB (BIB-HMAC-SHA2, HMAC 256, scope ${process.env.BIB_SCOPE ?? 7}, MAC input ${MODE}) over the payload`);
  }
  const raw = encodeBundle(bundle);
  const now = Date.now();
  const out = V2
    ? stampBundleV2(raw, { kp: kUp, eid: UP }, { prevHop: "dtn://source.dtn/", receivedAt: DTN_NOW(), forwardedAt: DTN_NOW() })
    : stampBundle(raw, makeRelay(kUp, UP), { prevHop: "dtn://source.dtn/", receivedAt: now, forwardedAt: now });
  fs.writeFileSync(a, out.toString("hex"));
  console.log(`[live] hop 1 (${UP}) stamped${V2 ? " with a version 2 receipt (COSE_Sign1)" : ""}; bundle ${fs.readFileSync(a, "utf8").length / 2} bytes, handed to ${VIA.replace(/^(two |one )?unaware /, "")}`);
} else if (mode === "check") {
  const sent = decodeBundle(Buffer.from(fs.readFileSync(a, "utf8").trim(), "hex"));
  const gotBytes = Buffer.from(fs.readFileSync(b, "utf8").trim(), "hex");
  const got = decodeBundle(gotBytes);
  const show = (x) => x.blocks.map((k) => k.type).join(",");
  console.log(`[live] sent blocks [${show(sent)}], received blocks [${show(got)}] (the stack may add or update its own)`);
  const intact = custodyBlock(got) && custodyBlock(got).data.equals(custodyBlock(sent).data)
    && custodyBlock(got).flags === custodyBlock(sent).flags;
  console.log(`[live] custody block after ${VIA}: ${intact ? "byte-identical" : "CHANGED OR MISSING"}`);
  const now = Date.now();
  if (V2) {
    // Version 2: hop 2 names the node the stack reports (Previous Node) or, with none, the
    // gateway; the verifier pins both keys and checks bundle identity and payload hash.
    const keys = { [UP]: kUp.pub, [DOWN]: kDown.pub }, via = previousNode(got);
    const final = stampBundleV2(gotBytes, { kp: kDown, eid: DOWN }, { prevHop: via ?? UP, receivedAt: DTN_NOW(), forwardedAt: DTN_NOW() });
    const v2 = verifyBundleV2(final, { keys, origin: "dtn://source.dtn/", lastNode: DOWN });
    let bibOk = true;
    if (BPSEC) {
      const r = verifyBibs(decodeBundle(final), BIB_KEY, { mode: MODE }); bibOk = r.ok;
      console.log(`[live] BPSec BIB over the payload after hop 2 appended: ${r.ok ? "verifies" : "FAILS " + r.reason}`);
    }
    console.log(`[live] hop 2 (${DOWN}) stamped, version 2 chain: ${JSON.stringify(v2)}`);
    const want = via ? v2.ok && v2.gaps.length === 1 && v2.gaps[0].lastUnsigned === via : v2.ok && v2.complete;
    process.exit(intact && want && bibOk ? 0 : 1);
  }
  const final = stampBundle(gotBytes, makeRelay(kDown, DOWN), { prevHop: UP, receivedAt: now, forwardedAt: now });
  const v = verifyBundleCustody(final, { hops });
  let bibOk = true;
  if (BPSEC) {
    const onArrival = verifyBibs(got, BIB_KEY, { mode: MODE }), afterHop2 = verifyBibs(decodeBundle(final), BIB_KEY, { mode: MODE });
    bibOk = onArrival.ok && afterHop2.ok;
    console.log(`[live] BPSec BIB over the payload: on arrival ${onArrival.ok ? "verifies" : "FAILS " + onArrival.reason}; after hop 2 appended ${afterHop2.ok ? "verifies" : "FAILS " + afterHop2.reason}`);
  }
  console.log(`[live] hop 2 (${DOWN}) stamped; chain of ${readCustody(decodeBundle(final)).length}: ${JSON.stringify(v)}`);
  // The same arrival audited the honest way: hop 2 names the node the stack says handed it
  // the bundle (its Previous Node block), so the unsigned stretch through the stack shows
  // up as an uncustodied transit gap instead of being read as custody.
  let auditOk = true;
  const via = previousNode(got);
  if (via) {
    const honest = stampBundle(gotBytes, makeRelay(kDown, DOWN), { receivedAt: now, forwardedAt: now });
    const au = auditBundleCustody(honest, { keys: { [UP]: kUp.pub, [DOWN]: kDown.pub }, origin: "dtn://source.dtn/", lastNode: DOWN });
    auditOk = au.ok && au.gaps.length === 1 && au.gaps[0].lastUnsigned === via;
    console.log(`[live] audit with the stack's Previous Node (${via}) as hop 2's prevHop: ${JSON.stringify({ ok: au.ok, complete: au.complete, custodied: au.custodied, gaps: au.gaps })}`);
  }
  process.exit(intact && v.ok && bibOk && auditOk ? 0 : 1);
} else {
  console.error("usage: node live.mjs make <out.hex> | check <in.hex> <out.hex>"); process.exit(2);
}
