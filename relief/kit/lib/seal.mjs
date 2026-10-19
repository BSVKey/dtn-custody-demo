// End-to-end encryption to the hub: X25519 + HKDF-SHA256 + AES-256-GCM. The hub's
// encryption key is provisioned on each clinic device before deployment; the custody layer
// signs and verifies the ciphertext, and only the hub can read it. The AAD binds the
// ciphertext to its payloadId, so a sealed report cannot be replayed under another id.
//
// Sealed layout: [1 byte epk length][epk SPKI DER][12 byte IV][16 byte tag][ciphertext]
import { createCipheriv, createDecipheriv, createPublicKey, createPrivateKey, diffieHellman, generateKeyPairSync, hkdfSync, randomBytes } from "node:crypto";

const INFO = "relief-report/1";
const derive = (priv, pub) => Buffer.from(hkdfSync("sha256", diffieHellman({ privateKey: priv, publicKey: pub }), Buffer.alloc(0), INFO, 32));

export function genEncKeypair() {
  const { publicKey, privateKey } = generateKeyPairSync("x25519");
  return {
    pub: publicKey.export({ type: "spki", format: "der" }).toString("base64"),
    priv: privateKey.export({ type: "pkcs8", format: "pem" }),
  };
}

const pubKey = (k) => (typeof k === "string" ? createPublicKey({ key: Buffer.from(k, "base64"), format: "der", type: "spki" }) : k);
const privKey = (k) => (typeof k === "string" ? createPrivateKey(k) : k);

export function sealTo(hubPub, plaintext, aad) {
  const eph = generateKeyPairSync("x25519");
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", derive(eph.privateKey, pubKey(hubPub)), iv).setAAD(Buffer.from(aad));
  const ct = Buffer.concat([c.update(plaintext), c.final()]);
  const epk = eph.publicKey.export({ type: "spki", format: "der" });
  return Buffer.concat([Buffer.from([epk.length]), epk, iv, c.getAuthTag(), ct]);
}

// Throws if the ciphertext, tag or AAD do not match.
export function openAt(hubPriv, sealed, aad) {
  const n = sealed[0];
  const epk = createPublicKey({ key: sealed.subarray(1, 1 + n), format: "der", type: "spki" });
  const iv = sealed.subarray(1 + n, 13 + n), tag = sealed.subarray(13 + n, 29 + n), ct = sealed.subarray(29 + n);
  const d = createDecipheriv("aes-256-gcm", derive(privKey(hubPriv), epk), iv).setAAD(Buffer.from(aad));
  d.setAuthTag(tag);
  return Buffer.concat([d.update(ct), d.final()]);
}
