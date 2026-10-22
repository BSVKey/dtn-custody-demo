// Compare the onboard keyring's answers (kr_check output on stdin) with the reference
// keyring's (expected.json). Usage: ./kr_check < in.txt | node flight/check-keyring.mjs expected.json
import { readFileSync } from "node:fs";

const expected = JSON.parse(readFileSync(process.argv[2], "utf8"));
const got = {};
for (const line of readFileSync(0, "utf8").split("\n").filter(Boolean)) {
  const [name, ok, reason, from] = line.split(" ");
  got[name] = { ok: Number(ok), reason, revokedFrom: from === "-" ? null : Number(from) };
}
let fail = 0;
for (const [name, want] of Object.entries(expected)) {
  const g = got[name];
  const same = g && g.ok === want.ok && g.reason === want.reason && g.revokedFrom === want.revokedFrom;
  if (!same) fail++;
  console.log(`  ${name.padEnd(30)} ${want.ok ? "ok" : want.reason}${want.revokedFrom ? ` revoked from ${want.revokedFrom}` : ""}`.padEnd(70) + (same ? "SAME" : `DIFFERS: C says ${JSON.stringify(g)}`));
}
const extra = Object.keys(got).filter((k) => !(k in expected));
console.log(`KEYRING_RESULT ${JSON.stringify({ ok: fail === 0 && !extra.length, queries: Object.keys(expected).length, differ: fail, extra: extra.length })}`);
process.exit(fail || extra.length ? 1 : 0);
