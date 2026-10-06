// Signed contact plans: a record that fixes exactly which plan, and which compiled files, a
// network operator put in force, from when to when. Later, anyone holding the plan and the
// operator's public key can check whether a contact (or a missed one) was in the plan at the
// time, and that nobody edited the plan afterwards.
//
//   dtn.contact-plan/1  { network, version, validFrom, validTo, planFingerprint, exports:
//                         { hdtn, ion, hardy } fingerprints, contacts, nodes, prev }
// Same primitives as every custody record here: canonical JSON, SHA-256 content id, Ed25519.
import { createHash } from "node:crypto";
import { canonicalize } from "../agent/lib/canonical.mjs";
import { signRecord, verifyRecord } from "../agent/lib/receipt.mjs";

const fp = (text) => "0x" + createHash("sha256").update(text).digest("hex");
export const planFingerprint = (plan) => fp(canonicalize(plan));

// exports: { hdtn: string, ion: string, hardy?: string }: the exact text of each compiled file.
export function signPlan(kp, { plan, exports, network, version, validFrom, validTo, prev = null }) {
  return signRecord(kp, {
    kind: "dtn.contact-plan/1", network, version, validFrom, validTo, prev,
    planFingerprint: planFingerprint(plan), contacts: plan.contacts.length, nodes: (plan.nodes || []).length,
    exports: Object.fromEntries(Object.entries(exports).filter(([, v]) => v != null).map(([k, v]) => [k, fp(v)])),
  });
}

// Check a signed plan record against the operator's key, the plan, and any compiled files.
export function verifyPlan(record, { pub, plan, exports = {} }) {
  const problems = [];
  const v = verifyRecord(record);
  if (!v.ok) problems.push(v.reason);
  else if (pub && record.signerPub !== pub) problems.push("not_signed_by_this_operator");
  if (record.kind !== "dtn.contact-plan/1") problems.push("not_a_contact_plan_record");
  if (plan && planFingerprint(plan) !== record.planFingerprint) problems.push("plan_differs_from_signed_plan");
  const files = {};
  for (const [k, text] of Object.entries(exports)) {
    if (text == null) continue;
    if (!record.exports?.[k]) files[k] = "not in the signed record";
    else files[k] = fp(text) === record.exports[k] ? "matches" : "DIFFERS";
    if (files[k] === "DIFFERS") problems.push(`${k}_file_differs`);
  }
  return { ok: problems.length === 0, problems, files };
}

// Was a contact between two nodes in force at time t (seconds from the plan's epoch)?
export function contactAt(plan, from, to, tS) {
  const links = new Map(plan.links.map((l) => [l.id, l]));
  return plan.contacts.filter((c) => { const l = links.get(c.link); return l && l.from === from && l.to === to && c.up_s <= tS && tS < c.down_s; });
}
