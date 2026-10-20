// Browser stand-ins for the two Node built-ins radio/lib uses, so the page runs the same code
// as the gateway and the tests. esbuild injects Buffer and aliases node:crypto to this file.
import { Buffer } from "buffer";
import { Hash } from "@bsv/sdk";

export { Buffer };

export function createHash(alg) {
  if (alg !== "sha256") throw new Error(`only sha256 is available in the browser, not ${alg}`);
  const parts = [];
  return {
    update(d) { parts.push(typeof d === "string" ? Buffer.from(d, "utf8") : Buffer.from(d)); return this; },
    digest(enc) {
      const h = Buffer.from(Hash.sha256([...Buffer.concat(parts)]));
      return enc ? h.toString(enc) : h;
    },
  };
}
