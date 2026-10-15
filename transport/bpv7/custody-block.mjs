// Custody Receipt Block: the custody chain carried inside the BPv7 bundle it describes,
// as an extension block, instead of as separate bundles to a /custody endpoint.
//
// Block type 224 (RFC 9171 private/experimental range 192-255; JPL ION already uses 192 to
// 197 for its own blocks, and parses 193 as its QoS block). Block-type-specific data
// is a CBOR array of text strings; each string is the canonical JSON of one signed
// custody/1 record, so signatures verify byte for byte with no re-serialization rules.
// Each custodian appends its own receipt. Flags: replicate in every fragment, and NOT
// "delete bundle" or "discard block" if unprocessed, so a BPv7 node that has never heard
// of this block keeps it and forwards it unchanged (RFC 9171 section 5.4 step 3/4).
// The block is outside any BIB that targets the payload, so appending a receipt never
// breaks a BPSec (RFC 9172) payload signature.
import { encode, decode } from "./cbor.mjs";
import { decodeBundle, encodeBundle, putBlock, payloadOf, decodeEid, BLOCK, BLOCK_FLAG, CRC32C } from "./bundle.mjs";
import { canonicalize, contentId } from "../../agent/lib/canonical.mjs";
import { verifyCustodyChain } from "../../agent/lib/receipt.mjs";

export const CUSTODY_BLOCK_TYPE = 224;
const FLAGS = BLOCK_FLAG.REPLICATE_IN_FRAGMENTS;

// Receipts carried by a decoded bundle ([] when the block is absent).
export function readCustody(bundle) {
  const b = bundle.blocks.find((x) => x.type === CUSTODY_BLOCK_TYPE);
  if (!b) return [];
  const arr = decode(b.data);
  if (!Array.isArray(arr) || !arr.every((s) => typeof s === "string")) throw new Error("custody block malformed");
  return arr.map((s) => JSON.parse(s));
}

export function withCustody(bundle, receipts) {
  const data = encode(receipts.map((r) => canonicalize(r)));
  return putBlock(bundle, { type: CUSTODY_BLOCK_TYPE, flags: FLAGS, crcType: CRC32C, data });
}

// The application bundle id this BPv7 bundle carries: the payload is the JSON chunk
// body {payloadId, index, leafHex, bytesB64, branch} from agent/source.mjs.
export function chunkOf(bundle) {
  const body = JSON.parse(payloadOf(bundle).toString("utf8"));
  return { body, bundleId: contentId({ payloadId: body.payloadId, index: body.index, leafHex: body.leafHex }) };
}

// The node that handed us this bundle: the Previous Node block (type 6) when a BPv7
// agent added one, else the caller's own knowledge.
export function previousNode(bundle) {
  const b = bundle.blocks.find((x) => x.type === BLOCK.PREVIOUS_NODE);
  return b ? decodeEid(decode(b.data)) : null;
}

// Relay step on raw bundle bytes: decode, append this hop's signed receipt, re-encode.
export function stampBundle(bytes, relay, { prevHop, receivedAt, forwardedAt }) {
  const bundle = decodeBundle(bytes);
  const { body, bundleId } = chunkOf(bundle);
  const prev = prevHop ?? previousNode(bundle);
  if (!prev) throw new Error("previous hop unknown: no Previous Node block and none supplied");
  const receipts = readCustody(bundle);
  const r = relay.stamp({ payloadId: body.payloadId, bundleId }, prev, receivedAt, forwardedAt);
  return encodeBundle(withCustody(bundle, [...receipts, r]));
}

// Destination check on raw bundle bytes: the carried chain must verify against the
// verifier's own pinned hops for the bundle id derived from the payload itself.
export function verifyBundleCustody(bytes, { hops }) {
  let bundle;
  try { bundle = decodeBundle(bytes); } catch (e) { return { ok: false, reason: "bundle_malformed", detail: e.message }; }
  let bundleId, receipts;
  try { ({ bundleId } = chunkOf(bundle)); } catch { return { ok: false, reason: "payload_not_a_chunk" }; }
  try { receipts = readCustody(bundle); } catch { return { ok: false, reason: "custody_block_malformed" }; }
  if (!receipts.length) return { ok: false, reason: "no_custody_block" };
  return { ...verifyCustodyChain(receipts, { bundleId, hops }), bundleId };
}
