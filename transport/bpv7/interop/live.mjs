// Live uD3TN check helper (see ud3tn-run.sh).
//   node live.mjs make <out.hex>            our gateway agent stamps hop 1, writes the bundle
//   node live.mjs check <in.hex> <out.hex>  after two unaware uD3TN nodes: block intact? stamp hop 2, verify
import fs from "node:fs";
import { createPrivateKey, createPublicKey } from "node:crypto";
import { encodeBundle, decodeBundle, BLOCK, CRC32C } from "../bundle.mjs";
import { stampBundle, verifyBundleCustody, readCustody, CUSTODY_BLOCK_TYPE } from "../custody-block.mjs";
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
const custodyBlock = (b) => b.blocks.find((x) => x.type === CUSTODY_BLOCK_TYPE);

const [mode, a, b] = process.argv.slice(2);
if (mode === "make") {
  const { bundles } = prepare(testKey("01".repeat(32)), Buffer.from("custody over real BPv7 ".repeat(100)), { chunkSize: 1024 });
  const c = bundles[0];
  const raw = encodeBundle({
    primary: { crcType: CRC32C, dest: "dtn://dest.dtn/payload", source: "dtn://gateway-up.dtn/payload", created: [Date.now() - DTN_EPOCH, 1], lifetime: 3600000 },
    blocks: [{ type: BLOCK.PAYLOAD, number: 1, crcType: CRC32C, data: Buffer.from(JSON.stringify({ payloadId: c.payloadId, index: c.index, leafHex: c.leafHex, bytesB64: c.bytesB64, branch: c.branch })) }],
  });
  const now = Date.now();
  fs.writeFileSync(a, stampBundle(raw, makeRelay(kUp, UP), { prevHop: "dtn://source.dtn/", receivedAt: now, forwardedAt: now }).toString("hex"));
  console.log(`[live] hop 1 (${UP}) stamped; bundle ${fs.readFileSync(a, "utf8").length / 2} bytes, handed to uD3TN relaya`);
} else if (mode === "check") {
  const sent = decodeBundle(Buffer.from(fs.readFileSync(a, "utf8").trim(), "hex"));
  const gotBytes = Buffer.from(fs.readFileSync(b, "utf8").trim(), "hex");
  const got = decodeBundle(gotBytes);
  const show = (x) => x.blocks.map((k) => k.type).join(",");
  console.log(`[live] sent blocks [${show(sent)}], received blocks [${show(got)}] (uD3TN may add or update its own)`);
  const intact = custodyBlock(got) && custodyBlock(got).data.equals(custodyBlock(sent).data)
    && custodyBlock(got).flags === custodyBlock(sent).flags;
  console.log(`[live] custody block after two unaware uD3TN hops: ${intact ? "byte-identical" : "CHANGED OR MISSING"}`);
  const now = Date.now();
  const final = stampBundle(gotBytes, makeRelay(kDown, DOWN), { prevHop: UP, receivedAt: now, forwardedAt: now });
  const v = verifyBundleCustody(final, { hops });
  console.log(`[live] hop 2 (${DOWN}) stamped; chain of ${readCustody(decodeBundle(final)).length}: ${JSON.stringify(v)}`);
  process.exit(intact && v.ok ? 0 : 1);
} else {
  console.error("usage: node live.mjs make <out.hex> | check <in.hex> <out.hex>"); process.exit(2);
}
