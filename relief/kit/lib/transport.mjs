// Transports for the kit's nodes. Both have the same shape:
//   { eid, send(toEid, buf) -> Promise, onFrame(fn(buf)), close() }
// `eid` is the node id that custody receipts name; frames are addressed to a node id.
//
//   aapTransport:    real BPv7 through a local µD3TN over its Application Agent Protocol.
//                    µD3TN stores and forwards the bundles, holding them through outages.
//   memoryTransport: in-process, for tests and the offline demo; an optional delay per
//                    destination stands in for links.
import { AAP } from "../../../r2/aap.mjs";

export const AGENT_ID = "relief";
const endpoint = (eid) => eid.replace(/\/?$/, "/") + AGENT_ID;

export async function aapTransport({ eid, host = "127.0.0.1", port }) {
  const a = new AAP();
  await a.connect(host, Number(port));
  await a.register(AGENT_ID);
  const handlers = [];
  a.on("bundle", (_src, payload) => { for (const h of handlers) h(payload); });
  return {
    eid,
    send: (to, buf) => a.send(endpoint(to), buf),
    onFrame: (fn) => handlers.push(fn),
    close: () => a.sock?.destroy(),
  };
}

export function memoryNetwork({ delayMs = {} } = {}) {
  const nodes = new Map();
  const pending = new Set();
  return {
    transport(eid) {
      const handlers = [];
      nodes.set(eid, handlers);
      return {
        eid,
        send(to, buf) {
          const deliver = () => { for (const h of nodes.get(to) || []) h(Buffer.from(buf)); };
          const d = delayMs[to] ?? 0;
          return new Promise((res) => {
            const t = setTimeout(() => { pending.delete(t); deliver(); }, d);
            pending.add(t);
            res();
          });
        },
        onFrame: (fn) => handlers.push(fn),
        close: () => nodes.delete(eid),
      };
    },
    // Resolve once nothing is in flight (for tests).
    async settle() { while (pending.size) await new Promise((r) => setTimeout(r, 5)); await new Promise((r) => setImmediate(r)); },
  };
}
