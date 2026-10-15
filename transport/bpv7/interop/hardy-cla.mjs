// Hardy side of the live check: one gRPC convergence-layer session (Cla.Register) that
// dispatches our raw bundle into Hardy and catches the raw bundle Hardy forwards back out
// to its announced peer ipn:30.0, once the time-variant routing agent opens the contact.
//   node hardy-cla.mjs <in.hex> <out.hex> <sendAtEpochMs> [timeoutSecs]
import fs from "node:fs";
import { createRequire } from "node:module";

const require = createRequire("/opt/grpc/");
const grpc = require("@grpc/grpc-js");
const loader = require("@grpc/proto-loader");
const { cla } = grpc.loadPackageDefinition(loader.loadSync("cla.proto", {
  includeDirs: ["/app/hardy/proto"], keepCase: true, longs: Number, enums: String, defaults: true, oneofs: true,
}));
const [inHex, outHex, sendAtS, secsS] = process.argv.slice(2);
const fail = (m) => { console.log(`[hardy] ${m}`); process.exit(1); };
setTimeout(() => fail("nothing forwarded in time"), Number(secsS || 60) * 1000);

const s = new cla.Cla(process.env.BPA || "[::1]:50051", grpc.credentials.createInsecure()).Register();
s.write({ msg_id: 1, register: { name: "custody-block-cla", address_type: "CLA_ADDRESS_TYPE_PRIVATE" } });
s.on("data", (m) => {
  if (m.register) {
    s.write({ msg_id: 2, add_peer: { node_ids: ["ipn:30.0"], address: { address_type: "CLA_ADDRESS_TYPE_PRIVATE", address: Buffer.from("custody-rx") } } });
  } else if (m.add_peer) {
    if (!m.add_peer.added) fail("peer ipn:30.0 not added");
    setTimeout(() => {
      // Make the bundle at send time so its creation timestamp is fresh.
      const bundle = Buffer.from(fs.readFileSync(inHex, "utf8").trim(), "hex");
      s.write({ msg_id: 3, dispatch: { bundle, peer_node_id: "ipn:1.0" } });
      console.log(`[hardy] dispatched our ${bundle.length}-byte bundle into Hardy through the CLA API`);
    }, Math.max(0, Number(sendAtS) - Date.now()));
  } else if (m.dispatch) {
    console.log(`[hardy] Hardy's verdict on the bundle: ${m.dispatch.verdict}`);
    if (m.dispatch.verdict !== "DISPATCH_VERDICT_ACCEPTED") fail("refused");
  } else if (m.forward) {
    fs.writeFileSync(outHex, Buffer.from(m.forward.bundle).toString("hex"));
    s.write({ msg_id: m.msg_id, forward: { sent: {} } });
    console.log(`[hardy] Hardy forwarded a ${m.forward.bundle.length}-byte bundle to peer ipn:30.0`);
    setTimeout(() => process.exit(0), 200);
  } else if (m.status && m.status.code) {
    console.log(`[hardy] BPA status ${m.status.code}: ${m.status.message}`);
  }
});
s.on("error", (e) => fail(`stream error: ${e.message}`));
