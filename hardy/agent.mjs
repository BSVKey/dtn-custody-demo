// Custody agent on Aalyria's Hardy BPA, through Hardy's public gRPC APIs only.
//
// ROLE=bridge: registers as a convergence layer (Cla.Register), announces the downstream
//   peer ipn:30.0, and accepts every bundle Hardy forwards to it, saving the raw BPv7
//   bytes and the arrival time. Hardy only forwards when its time-variant routing agent
//   has a contact open for ipn:2.* via ipn:30.0.
// ROLE=source: registers as an application (Application.Register), chunks and
//   Merkle-commits a payload, signs the manifest and a custody handoff per chunk at the
//   sending endpoint, and sends each to ipn:2.1 inside the scheduled gap.
import { createRequire } from "node:module";
import { writeFileSync, mkdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { genKeypair } from "../agent/lib/keys.mjs";
import { prepare } from "../agent/source.mjs";
import { custodyReceipt } from "../agent/lib/receipt.mjs";

const require = createRequire("/opt/grpc/");
const grpc = require("@grpc/grpc-js");
const loader = require("@grpc/proto-loader");
const load = (f) => grpc.loadPackageDefinition(loader.loadSync(f, { includeDirs: ["/app/hardy/proto"], keepCase: true, longs: Number, defaults: true, oneofs: true }));
const BPA = process.env.BPA || "[::1]:50051";
const OUT = "/tmp/fwd";

function bridge() {
  const { cla } = load("cla.proto");
  const client = new cla.Cla(BPA, grpc.credentials.createInsecure());
  const s = client.Register();
  let n = 0;
  mkdirSync(OUT, { recursive: true });
  s.write({ msg_id: 1, register: { name: "custody-bridge", address_type: "CLA_ADDRESS_TYPE_PRIVATE" } });
  s.on("data", (m) => {
    if (m.register) {
      s.write({ msg_id: 2, add_peer: { node_ids: ["ipn:30.0"], address: { address_type: "CLA_ADDRESS_TYPE_PRIVATE", address: Buffer.from("custody-rx") } } });
      console.log(`[hardy] custody bridge registered as a Hardy CLA (node ${m.register.node_ids.join(",")}); peer ipn:30.0 announced`);
    } else if (m.add_peer) {
      console.log(`[hardy] peer ipn:30.0 ${m.add_peer.added ? "added" : "NOT added"}`);
    } else if (m.forward) {
      const f = `${OUT}/b${String(++n).padStart(3, "0")}.bundle`;
      writeFileSync(f, m.forward.bundle);
      writeFileSync(f + ".t", String(Date.now()));
      s.write({ msg_id: m.msg_id, forward: { sent: {} } });
    } else if (m.status && m.status.code) {
      console.log(`[hardy] BPA status ${m.status.code}: ${m.status.message}`);
    }
  });
  s.on("error", (e) => { console.log(`[hardy] bridge stream error: ${e.message}`); process.exit(1); });
}

function source() {
  const { service } = load("service.proto");
  const client = new service.Application(BPA, grpc.credentials.createInsecure());
  const s = client.Register();
  const src = genKeypair(), sender = genKeypair();
  const payload = Buffer.from("DTN CUSTODY on Aalyria Hardy: chunked, Merkle-committed, custody-signed, held by time-variant routing. ".repeat(12), "utf8");
  const { manifest, bundles } = prepare(src, payload, { payloadId: "0xhardy-interop-001", chunkSize: 64 });
  let eid = null, id = 10, acked = 0;
  const frames = [];
  s.write({ msg_id: 1, register: { ipn: 1 } });
  s.on("data", (m) => {
    if (m.register) {
      eid = m.register.endpoint_id;
      writeFileSync("/tmp/pins.json", JSON.stringify({ sourcePub: src.pub, senderPub: sender.pub, senderEid: eid, payloadSha256: createHash("sha256").update(payload).digest("hex"), chunks: bundles.length }));
      frames.push({ kind: "manifest", manifest });
      const now = Date.now();
      for (const b of bundles) frames.push({ kind: "bundle", bundle: b, custody: [custodyReceipt(sender, { payloadId: b.payloadId, bundleId: b.bundleId, prevHop: "app:source", thisHop: eid, receivedAt: now, forwardedAt: now })] });
      for (const f of frames) s.write({ msg_id: id++, send: { destination: "ipn:2.1", payload: Buffer.from(JSON.stringify(f)), lifetime: 600000 } });
    } else if (m.send) {
      if (++acked === frames.length) {
        console.log(`[hardy] application ${eid} handed Hardy manifest + ${bundles.length} bundles for ipn:2.1`);
        s.end(); setTimeout(() => process.exit(0), 300);
      }
    } else if (m.status && m.status.code) {
      console.log(`[hardy] BPA refused send: ${m.status.code} ${m.status.message}`); process.exit(1);
    }
  });
  s.on("error", (e) => { console.log(`[hardy] app stream error: ${e.message}`); process.exit(1); });
}

process.env.ROLE === "source" ? source() : bridge();
