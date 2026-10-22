// Clearing between operators, from receipts alone. Every claim is a delivered bundle as bytes:
// the honest copies the destinations received, and whatever else anyone submits. Each receipt
// in a claim is judged on its own (unlike verifyBundleV2, which refuses a whole chain): its
// place in the chain (field 9), its signature, its key's status at the time it claims, and,
// for a key revoked later, whether something trustworthy saw it in time. Only credited
// receipts earn, once per (bundle, custodian), at the custodian operator's rate card, paid by
// the bundle's owner. The clearing house signs one statement per operator.
import { createHash } from "node:crypto";
import { encode } from "../transport/bpv7/cbor.mjs";
import { decodeBundle } from "../transport/bpv7/bundle.mjs";
import { readBlockItems, receiptFields, bundleIdentity } from "../transport/bpv7/receipt-v2.mjs";
import { verify1 } from "../transport/bpv7/cose.mjs";
import { signRecord } from "../agent/lib/receipt.mjs";
import { buildTree } from "../agent/lib/merkle.mjs";
import { NODES, OPERATORS } from "./world.mjs";

const chainDigest = (items) => createHash("sha256").update(encode(items)).digest();
const sha = (x) => createHash("sha256").update(x).digest("hex");

// claims: [{ data, arrivedAt (DTN ms, the owner's own clock), source: "delivery" | "submitted", note }]
// delivered: Set of bundle identity strings the owner actually received.
export function clear({ claims, keyring, delivered, owner = "science", clearingKey, period }) {
  const credited = new Map(), rejected = [], perOp = {};
  for (const op of Object.keys(OPERATORS)) perOp[op] = { bundles: 0, bytes: 0, amount: 0, leaves: [], rejected: 0, unsignedHops: 0 };
  for (const claim of claims) {
    const b = decodeBundle(claim.data), id = JSON.stringify(bundleIdentity(b));
    const payloadBytes = b.blocks.find((x) => x.type === 1).data.length;
    if (!delivered.has(id)) { rejected.push({ claim: claim.note, reason: "bundle_never_delivered" }); continue; }
    const { items } = readBlockItems(b);
    const f = items.map(receiptFields);
    const verdicts = items.map((item, i) => {
      if (f[i].chain !== undefined && !chainDigest(items.slice(0, i)).equals(f[i].chain)) return { reason: "chain_digest_mismatch" };
      const pub = keyring.pubsFor(f[i].thisHop).find((p) => verify1(item, p).ok);
      if (!pub) return { reason: "signature_invalid" };
      const st = keyring.status(pub, f[i].thisHop, f[i].forwardedAt ?? f[i].receivedAt);
      if (!st.ok) return { reason: st.reason };
      return { ok: true, revokedFrom: st.revokedFrom };
    });
    // A tampered chain earns nothing for anyone: the claim is refused as a whole.
    if (verdicts.some((v) => v.reason === "chain_digest_mismatch")) { rejected.push({ claim: claim.note, reason: "chain_digest_mismatch" }); continue; }
    for (let i = 0; i < items.length; i++) {
      const v = verdicts[i], hop = f[i].thisHop, op = NODES[hop]?.op;
      if (v.ok && v.revokedFrom !== null && v.revokedFrom !== undefined) {
        const t = f[i].forwardedAt ?? f[i].receivedAt;
        if (!(t < v.revokedFrom)) Object.assign(v, { ok: false, reason: "signed_after_revocation" });
        else {
          const witness = f.some((g, j) => j > i && g.chain !== undefined && verdicts[j].ok && verdicts[j].revokedFrom == null && g.receivedAt < v.revokedFrom)
            || claim.arrivedAt < v.revokedFrom;
          if (!witness) Object.assign(v, { ok: false, reason: "revoked_unwitnessed" });
        }
      }
      if (!v.ok) { rejected.push({ claim: claim.note, hop, op, reason: v.reason }); if (op) perOp[op].rejected++; continue; }
      if (op === owner) continue;
      const key = `${id}|${hop}`;
      if (credited.has(key)) continue;   // a second claim for the same carriage earns nothing more
      const amount = (payloadBytes / 1e6) * OPERATORS[op].ratePerMB;
      credited.set(key, { op, amount });
      Object.assign(perOp[op], { bundles: perOp[op].bundles + 1, bytes: perOp[op].bytes + payloadBytes, amount: perOp[op].amount + amount });
      perOp[op].leaves.push(sha(encode(items[i])));
    }
    // Plain forwarders between custodians: carried, unsigned, unbillable.
    for (let i = 1; i < items.length; i++) {
      const a = f[i - 1].hopCount, c = f[i].hopCount;
      if (a && c && c[0] - a[1] > 0 && claim.source === "delivery") claim.unsigned = (claim.unsigned || 0) + (c[0] - a[1]);
    }
  }
  const statements = {};
  for (const [op, s] of Object.entries(perOp)) {
    if (op === owner || !s.bundles) continue;
    const root = buildTree(s.leaves.sort()).root;
    statements[op] = signRecord(clearingKey, {
      kind: "ssi.settlement/1", operator: op, payer: owner, period,
      bundles: s.bundles, bytes: s.bytes, amount: Number(s.amount.toFixed(6)), ratePerMB: OPERATORS[op].ratePerMB, receiptsRoot: root,
    });
  }
  return { perOp, rejected, statements, credited: credited.size };
}
