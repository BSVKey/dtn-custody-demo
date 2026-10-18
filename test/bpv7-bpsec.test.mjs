import { test } from "node:test";
import assert from "node:assert/strict";
import { encode } from "../transport/bpv7/cbor.mjs";
import { encodeBundle, decodeBundle, encodeEid, BLOCK, CRC16, CRC32C } from "../transport/bpv7/bundle.mjs";
import { addBib, verifyBibs, ippt, unwrapKey, SHA, IPPT_MODE } from "../transport/bpv7/bpsec.mjs";
import fs from "node:fs";
import { stampBundle, verifyBundleCustody, CUSTODY_BLOCK_TYPE } from "../transport/bpv7/custody-block.mjs";
import { genKeypair } from "../agent/lib/keys.mjs";
import { makeRelay } from "../agent/relay.mjs";
import { prepare } from "../agent/source.mjs";

// RFC 9173 Appendix A: key, payload and the original bundle shared by A.1 and A.4.
const hex = (s) => Buffer.from(s.replace(/\s+/g, ""), "hex");
const KEY = hex("1a2b1a2b1a2b1a2b1a2b1a2b1a2b1a2b");
const PAYLOAD = Buffer.from("Ready to generate a 32-byte payload");
const ORIGINAL = hex(`9f88070000820282010282028202018202820201820018281a000f424085010100
  005823526561647920746f2067656e657261746520612033322d62797465207061796c6f6164ff`);
const base = () => ({
  primary: { flags: 0, crcType: 0, dest: "ipn:1.2", source: "ipn:2.1", reportTo: "ipn:2.1", created: [0, 40], lifetime: 1000000 },
  blocks: [{ type: BLOCK.PAYLOAD, number: 1, flags: 0, crcType: 0, data: PAYLOAD }],
});

test("bpsec: our codec reproduces the RFC 9173 Appendix A original bundle", () => {
  assert.ok(encodeBundle(base()).equals(ORIGINAL));
  assert.ok(encodeBundle(decodeBundle(ORIGINAL)).equals(ORIGINAL));
});

test("bpsec: RFC 9173 A.1 (HMAC 512, no extra scope) final bundle byte for byte", () => {
  const out = addBib(base(), { targets: [1], key: KEY, source: "ipn:2.1", shaVariant: SHA.HMAC512, scope: 0, number: 2 });
  assert.equal(encodeBundle(out).toString("hex"), hex(`9f88070000820282010282028202018202820201820018281a000f4240850b0200
    005856810101018202820201828201078203008181820158403bdc69b3a34a2b5d3a
    8554368bd1e808f606219d2a10a846eae3886ae4ecc83c4ee550fdfb1cc636b904e2
    f1a73e303dcd4b6ccece003e95e8164dcc89a156e185010100005823526561647920
    746f2067656e657261746520612033322d62797465207061796c6f6164ff`).toString("hex"));
  assert.equal(verifyBibs(decodeBundle(encodeBundle(out)), KEY).ok, true);
});

test("bpsec: RFC 9173 A.3 (targets: primary block and Bundle Age, HMAC 256) security block byte for byte", () => {
  const b = base();
  b.blocks.unshift({ type: BLOCK.BUNDLE_AGE, number: 2, flags: 0, crcType: 0, data: hex("19012c") });
  const out = addBib(b, { targets: [0, 2], key: KEY, source: "ipn:3.0", shaVariant: SHA.HMAC256, scope: 0, number: 3 });
  const bib = out.blocks.find((x) => x.type === BLOCK.BIB);
  assert.equal(bib.data.toString("hex"), hex(`8200020101820282030082820105820300828182015820cac6ce8e4c5dae57988b
    757e49a6dd1431dc04763541b2845098265bc817241b81820158203ed614c0d97f49
    b3633627779aa18a338d212bf3c92b97759d9739cd50725596`).toString("hex"));
  assert.equal(verifyBibs(out, KEY).ok, true);
});

test("bpsec: RFC 9173 A.4 (HMAC 384, full scope 0x07) IPPT and security block byte for byte", () => {
  const b = base();
  const out = addBib(b, { targets: [1], key: KEY, source: "ipn:2.1", shaVariant: SHA.HMAC384, scope: 7, number: 3 });
  assert.equal(ippt(b, b.blocks[0], { number: 3, flags: 0 }, 7).toString("hex"), hex(`07880700008202820102820282020182
    02820201820018281a000f4240010100 0b03005823526561647920746f206765
    6e657261746520612033322d62797465 207061796c6f6164`).toString("hex"));
  assert.equal(out.blocks.find((x) => x.type === BLOCK.BIB).data.toString("hex"), hex(`81010101820282020182820106820307818182015830f75fe4c37f76f046165855
    bd5ff72fbfd4e3a64b4695c40e2b787da005ae819f0a2e30a2e8b325527de8aefb52
    e73d71`).toString("hex"));
});

// ---- The point: custody receipts and a payload BIB coexist -------------------------
function signedChunk() {
  const { bundles } = prepare(genKeypair(), Buffer.from("bpsec + custody ".repeat(200)), { chunkSize: 1024 });
  const c = bundles[0];
  const b = {
    primary: { crcType: CRC32C, dest: "ipn:2.1", source: "ipn:1.1", created: [1000, 1], lifetime: 3600000 },
    blocks: [{ type: BLOCK.PAYLOAD, number: 1, crcType: CRC32C, data: Buffer.from(JSON.stringify({ payloadId: c.payloadId, index: c.index, leafHex: c.leafHex, bytesB64: c.bytesB64, branch: c.branch })) }],
  };
  return encodeBundle(addBib(b, { targets: [1], key: KEY, source: "ipn:1.1", scope: 7 }));
}
function relays() {
  const a = genKeypair(), c = genKeypair();
  return { A: makeRelay(a, "dtn://a/"), C: makeRelay(c, "dtn://c/"), hops: [{ eid: "dtn://a/", pub: a.pub }, { eid: "dtn://c/", pub: c.pub }] };
}

test("bpsec: a full-scope payload BIB still verifies after two custodians append receipts", () => {
  const { A, C, hops } = relays();
  const atA = stampBundle(signedChunk(), A, { prevHop: "dtn://src/", receivedAt: 1, forwardedAt: 2 });
  const atC = stampBundle(atA, C, { prevHop: "dtn://a/", receivedAt: 3, forwardedAt: 4 });
  const b = decodeBundle(atC);
  assert.deepEqual(b.blocks.map((x) => x.type), [BLOCK.BIB, CUSTODY_BLOCK_TYPE, BLOCK.PAYLOAD]);
  assert.equal(verifyBibs(b, KEY).ok, true, "payload BIB intact");
  assert.equal(verifyBundleCustody(atC, { hops }).ok, true, "custody chain intact");
});

test("bpsec: forwarders adding standard blocks do not break the BIB either", () => {
  const b = decodeBundle(signedChunk());
  b.blocks.unshift({ type: BLOCK.PREVIOUS_NODE, number: 7, crcType: CRC16, data: encode(encodeEid("ipn:10.0")) },
    { type: BLOCK.BUNDLE_AGE, number: 8, crcType: 0, data: encode(1500) });
  assert.equal(verifyBibs(decodeBundle(encodeBundle(b)), KEY).ok, true);
});

test("bpsec: payload tampering, wrong key and header changes are refused", () => {
  const good = decodeBundle(signedChunk());
  const p = good.blocks.find((x) => x.type === BLOCK.PAYLOAD);
  const tampered = { ...good, blocks: good.blocks.map((x) => (x === p ? { ...x, data: Buffer.concat([p.data, Buffer.from(" ")]) } : x)) };
  assert.equal(verifyBibs(tampered, KEY).reason, "mac_mismatch");
  assert.equal(verifyBibs(good, Buffer.alloc(16, 9)).reason, "mac_mismatch");
  const moved = { ...good, primary: { ...good.primary, dest: "ipn:9.1" } };
  assert.equal(verifyBibs(moved, KEY).reason, "mac_mismatch", "scope 0x07 covers the primary block");
  const reflagged = { ...good, blocks: good.blocks.map((x) => (x === p ? { ...x, flags: 0x04 } : x)) };
  assert.equal(verifyBibs(reflagged, KEY).reason, "mac_mismatch", "and the payload header");
});

test("bpsec: the target's CRC is removed when the BIB is added, and a CRC on a target is refused (RFC 9173 3.8.1)", () => {
  const b = decodeBundle(signedChunk());
  const p = b.blocks.find((x) => x.type === BLOCK.PAYLOAD);
  assert.equal(p.crcType, 0, "payload CRC removed (it was CRC-32C)");
  assert.equal(b.primary.crcType, CRC32C, "primary keeps its CRC: it is not a target here");
  const withCrc = { ...b, blocks: b.blocks.map((x) => (x === p ? { ...x, crcType: CRC32C } : x)) };
  assert.equal(verifyBibs(decodeBundle(encodeBundle(withCrc)), KEY).reason, "target_has_crc");
});

// ---- Interop with JPL ION (c5a4d87, built with Mbed TLS) ---------------------------
test("bpsec: AES key unwrap matches the RFC 3394 section 4.1 vector, and a wrong key throws", () => {
  const kek = hex("000102030405060708090A0B0C0D0E0F");
  assert.equal(unwrapKey(kek, hex("1FA68B0A8112B447AEF34BD8FB5A7B829D3E862371D2CFE5")).toString("hex"),
    "00112233445566778899aabbccddeeff");
  assert.throws(() => unwrapKey(Buffer.alloc(16, 1), hex("1FA68B0A8112B447AEF34BD8FB5A7B829D3E862371D2CFE5")));
});

// A bundle captured from a live ION node that signed its payload (wrapped key, scope 7,
// no SHA variant parameter). ION builds the MAC input from the whole payload block and
// defaults to HMAC 256, so it verifies only in ion mode.
test("bpsec: a BIB signed by JPL ION verifies in ion mode only", () => {
  const b = decodeBundle(Buffer.from(fs.readFileSync(new URL("./fixtures/ion-c5a4d87-bib.hex", import.meta.url), "utf8"), "hex"));
  assert.equal(verifyBibs(b, KEY, { mode: IPPT_MODE.ION }).ok, true);
  assert.equal(verifyBibs(b, Buffer.alloc(16, 7), { mode: IPPT_MODE.ION }).reason, "key_unwrap_failed");
  assert.equal(verifyBibs(b, KEY).reason, "target_has_crc", "ION keeps the target CRC");
  const noCrc = { ...b, blocks: b.blocks.map((x) => (x.type === BLOCK.PAYLOAD ? { ...x, crcType: 0 } : x)) };
  assert.equal(verifyBibs(noCrc, KEY).reason, "mac_mismatch", "and its MAC input is not RFC 9173's");
});

test("bpsec: ion mode round-trips, and its MAC differs from RFC 9173 for a payload target", () => {
  const ion = addBib(base(), { targets: [1], key: KEY, source: "ipn:2.1", scope: 7, mode: IPPT_MODE.ION });
  assert.equal(verifyBibs(ion, KEY, { mode: IPPT_MODE.ION }).ok, true);
  assert.equal(verifyBibs(ion, KEY).reason, "mac_mismatch");
  const rfc = addBib(base(), { targets: [1], key: KEY, source: "ipn:2.1", scope: 7 });
  assert.equal(verifyBibs(rfc, KEY, { mode: IPPT_MODE.ION }).reason, "mac_mismatch");
  // A primary-block target is built the same way in both modes.
  const p = addBib(base(), { targets: [0], key: KEY, source: "ipn:2.1", scope: 4, mode: IPPT_MODE.ION });
  assert.equal(verifyBibs(p, KEY).ok, true);
});
