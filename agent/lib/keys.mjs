// Node identity keys and detached signatures.
//
// The demo uses Ed25519 via node:crypto so it runs anywhere with zero dependencies.
// PRODUCTION uses the compact Bitcoin Signed Message (BSM) envelope from
// @bsvkey/x402-bsv-client, where the signer is RECOVERED from the signature rather
// than carried. The content-addressing route (sha256 of canonical JSON) is identical;
// only the signature envelope differs, and it lives entirely behind this module.
import { generateKeyPairSync, sign as nodeSign, verify as nodeVerify, createPublicKey } from "node:crypto";

// A keypair: { priv (KeyObject), pub (base64 SPKI DER) }.
export function genKeypair() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const pub = publicKey.export({ type: "spki", format: "der" }).toString("base64");
  return { priv: privateKey, pub };
}

// Sign a claimId string; returns a base64 detached signature.
export function signClaim(priv, claimId) {
  return nodeSign(null, Buffer.from(String(claimId), "utf8"), priv).toString("base64");
}

// Verify a base64 signature over a claimId under a base64-SPKI public key.
export function verifySig(pubB64, claimId, sigB64) {
  try {
    const pub = createPublicKey({ key: Buffer.from(pubB64, "base64"), format: "der", type: "spki" });
    return nodeVerify(null, Buffer.from(String(claimId), "utf8"), pub, Buffer.from(sigB64, "base64"));
  } catch {
    return false;
  }
}
