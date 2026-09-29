// Ground side: build a CCSDS command packet for the CUSTODY app and send it to cFS's
// command ingest (ci_lab, UDP 1234). Layout matches CUSTODY_SignCmd_t on a native
// little-endian build: 8-byte command header, two uint64 times, four NUL-padded strings.
//   node send-cmd.mjs noop
//   node send-cmd.mjs sign <payloadId> <bundleId> <prevHop> <thisHop> <receivedAt> <forwardedAt>
//   node send-cmd.mjs sign-bad            (unterminated string field: must be refused)
import dgram from "node:dgram";

const MID = 0x18f0, SIZE = 288; // sizeof(CUSTODY_SignCmd_t): 8 + 8 + 8 + 64 + 68 + 64 + 64, padded to 8
let seq = Number(process.env.SEQ || 0);
function packet(fc, body = Buffer.alloc(0), size = 8 + body.length) {
  const b = Buffer.alloc(size);
  b.writeUInt16BE(MID, 0);                 // stream id: command, secondary header present, APID 0x0F0
  b.writeUInt16BE(0xc000 | (seq++ & 0x3fff), 2);
  b.writeUInt16BE(size - 7, 4);            // CCSDS length = total - 7
  b[6] = fc & 0x7f;                        // function code
  body.copy(b, 8);
  let x = 0xff;
  for (let i = 0; i < size; i++) if (i !== 7) x ^= b[i];
  b[7] = x;                                // checksum: XOR of the whole packet is 0xFF
  return b;
}
const str = (s, n) => { const f = Buffer.alloc(n); Buffer.from(s, "ascii").copy(f, 0, 0, n - 1); return f; };
function sign([payloadId, bundleId, prevHop, thisHop, receivedAt, forwardedAt]) {
  const t = Buffer.alloc(16);
  t.writeBigUInt64LE(BigInt(receivedAt), 0);
  t.writeBigUInt64LE(BigInt(forwardedAt), 8);
  return packet(1, Buffer.concat([t, str(payloadId, 64), str(bundleId, 68), str(prevHop, 64), str(thisHop, 64)]), SIZE);
}
const [cmd, ...args] = process.argv.slice(2);
let pkt;
if (cmd === "noop") pkt = packet(0);
else if (cmd === "sign") pkt = sign(args);
else if (cmd === "sign-bad") { pkt = sign(["p", "b", "a", "b", "1", "2"]); pkt.fill(0x41, 24, 24 + 64); } // PayloadId with no NUL
else { console.log("usage: node send-cmd.mjs noop | sign ... | sign-bad"); process.exit(2); }
const s = dgram.createSocket("udp4");
s.send(pkt, 1234, "127.0.0.1", (e) => { if (e) { console.error(e.message); process.exit(1); } s.close(); });
