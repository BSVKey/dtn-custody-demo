#!/usr/bin/env node
// Make a private test CA and one certificate per DTN node, each naming the node's Node ID
// as a subjectAltName otherName of type id-on-bundleEID (1.3.6.1.5.5.7.8.11, RFC 9174
// section 4.4.1), for TCPCLv4 over TLS:
//
//   node gateway/certs.mjs <out-dir> ipn:1.0 ipn:2.0 ...
//
// Writes ca.crt, ca.key and, per node, <n>.crt and <n>.key (":" becomes "_"). Uses the
// openssl command line. For trials only: in operations, use your organization's CA and
// keep ca.key offline.
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const run = (args, cwd) => execFileSync("openssl", args, { cwd, stdio: "pipe", env: { ...process.env, MSYS_NO_PATHCONV: "1" } });
const EC = ["-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1", "-nodes"];

export function makeCerts(dir, nodeIds, { days = 365 } = {}) {
  mkdirSync(dir, { recursive: true });
  if (!existsSync(join(dir, "ca.crt"))) {
    run(["req", "-x509", ...EC, "-keyout", "ca.key", "-out", "ca.crt", "-days", String(days), "-subj", "/CN=DTN gateway test CA",
      "-addext", "basicConstraints=critical,CA:TRUE", "-addext", "keyUsage=critical,keyCertSign,cRLSign"], dir);
  }
  const out = { ca: readFileSync(join(dir, "ca.crt")) };
  for (const id of nodeIds) {
    const f = id.replace(/[:/]/g, "_");
    writeFileSync(join(dir, `${f}.ext`), `subjectAltName=otherName:1.3.6.1.5.5.7.8.11;IA5STRING:${id}\nextendedKeyUsage=serverAuth,clientAuth\nbasicConstraints=CA:FALSE\nkeyUsage=critical,digitalSignature,keyAgreement\n`);
    run(["req", ...EC, "-keyout", `${f}.key`, "-out", `${f}.csr`, "-subj", `/CN=${id}`], dir);
    run(["x509", "-req", "-in", `${f}.csr`, "-CA", "ca.crt", "-CAkey", "ca.key", "-CAcreateserial", "-out", `${f}.crt`, "-days", String(days), "-extfile", `${f}.ext`], dir);
    out[id] = { key: readFileSync(join(dir, `${f}.key`)), cert: readFileSync(join(dir, `${f}.crt`)) };
  }
  return out;
}

// One self-signed certificate naming a Node ID, for a peer that verifies a single pinned
// certificate instead of a CA chain (HDTN's TCPCLv4 outduct at commit 7fbe90c checks the
// Node ID on every certificate in the chain, CA included, so it needs this form).
export function selfSigned(dir, id, { days = 365 } = {}) {
  mkdirSync(dir, { recursive: true });
  const f = `${id.replace(/[:/]/g, "_")}-self`;
  run(["req", "-x509", ...EC, "-keyout", `${f}.key`, "-out", `${f}.crt`, "-days", String(days), "-subj", `/CN=${id}`,
    "-addext", `subjectAltName=otherName:1.3.6.1.5.5.7.8.11;IA5STRING:${id}`, "-addext", "extendedKeyUsage=serverAuth,clientAuth"], dir);
  return { key: readFileSync(join(dir, `${f}.key`)), cert: readFileSync(join(dir, `${f}.crt`)), certFile: join(dir, `${f}.crt`) };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const [dir, ...ids] = process.argv.slice(2);
  if (!dir || !ids.length) { console.error("usage: node gateway/certs.mjs <out-dir> ipn:1.0 [ipn:2.0 ...]"); process.exit(2); }
  makeCerts(dir, ids);
  console.log(`wrote ca.crt and certificates for ${ids.join(", ")} to ${dir}`);
}
