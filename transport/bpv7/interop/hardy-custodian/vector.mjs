// Pinned cross-implementation vector for the Hardy custodian filter
// (hardy-custody-receipt/custody-receipt/tests/js_vector.rs): one version 2 receipt
// signed by the JS reference (receipt-v2.mjs, cose.mjs) with a freshly generated
// Ed25519 key, printed with the seed so the Rust encoder and signer can be checked
// byte for byte. Ed25519 is deterministic, so the same seed and fields give the same bytes.
//   node transport/bpv7/interop/hardy-custodian/vector.mjs
import { generateKeyPairSync, createHash } from "node:crypto";
import { encode, bstr } from "../../cbor.mjs";
import { sign1 } from "../../cose.mjs";

const { privateKey, publicKey } = generateKeyPairSync("ed25519");
const seed = privateKey.export({ format: "der", type: "pkcs8" }).subarray(-32);
const hash = createHash("sha256").update("hardy custodian vector payload").digest();
const fields = new Map([
  [1, "ipn:1.0"], [2, "ipn:20.0"], [3, ["ipn:1.1", [845000000123, 7]]],
  [4, bstr(hash)], [5, 845000001000], [6, 845000002000],
]);
const frag = new Map(fields);
frag.set(3, ["ipn:1.1", [845000000123, 7], 1024, 4096]);
frag.set(7, "subject-1");
const out = {
  seed: seed.toString("hex"),
  spki: publicKey.export({ format: "der", type: "spki" }).toString("base64"),
  payloadHash: hash.toString("hex"),
  whole: encode(sign1(privateKey, encode(fields))).toString("hex"),
  fragment: encode(sign1(privateKey, encode(frag))).toString("hex"),
};
console.log(JSON.stringify(out, null, 2));
