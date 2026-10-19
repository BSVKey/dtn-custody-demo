// Streaming Merkle tree: the same tree, root and inclusion proofs as merkle.mjs (leaf
// byte 0x00, node byte 0x01, an odd last node paired with itself), built one leaf at a
// time as bundles are taken into custody. Adding a leaf costs one hash on average and
// closing the tree costs log2(N) hashes, so a batch receipt can be signed the moment a
// contact ends. Memory is log2(N) hashes plus the proofs being collected.
//
// add(leaf, { watch: true }) collects that leaf's inclusion proof as the tree is built, for
// a caller that knows in advance which bundles it must prove (a node that must prove any
// bundle later keeps the leaves instead and uses merkle.mjs).
import { createHash } from "node:crypto";

const LEAF = Buffer.from([0x00]), NODE = Buffer.from([0x01]);
const h2 = (l, r) => createHash("sha256").update(NODE).update(l).update(r).digest();
export const leafOf = (bytes) => createHash("sha256").update(LEAF).update(bytes).digest();

export class StreamMerkle {
  constructor() { this.pending = []; this.count = 0; this.proofs = new Map(); this.done = null; }

  // Add a 32-byte leaf hash. Returns its index.
  add(leaf, { watch = false } = {}) {
    if (this.done) throw new Error("StreamMerkle: closed");
    if (!Buffer.isBuffer(leaf) || leaf.length !== 32) throw new Error("StreamMerkle: leaf must be a 32-byte hash");
    const index = this.count++;
    if (watch) this.proofs.set(index, []);
    let node = { h: leaf, w: watch ? [index] : null }, l = 0;
    while (this.pending[l]) { node = this.#join(this.pending[l], node); this.pending[l] = null; l++; }
    this.pending[l] = node;
    return index;
  }

  #join(L, R) {
    if (L.w) for (const i of L.w) this.proofs.get(i).push(R.h);
    if (R.w) for (const i of R.w) this.proofs.get(i).push(L.h);
    return { h: h2(L.h, R.h), w: L.w && R.w ? L.w.concat(R.w) : L.w ?? R.w };
  }
  #dup(P) {
    if (P.w) for (const i of P.w) this.proofs.get(i).push(P.h);
    return { h: h2(P.h, P.h), w: P.w };
  }

  // Close the tree: returns the root (Buffer). Call once.
  root() {
    if (this.done) return this.done;
    if (!this.count) throw new Error("StreamMerkle: no leaves");
    let carry = null;
    for (let l = 0; l < this.pending.length; l++) {
      const p = this.pending[l];
      const above = this.pending.slice(l + 1).some(Boolean);
      if (!above && (p ? !carry : carry)) { carry = p ?? carry; break; } // the single node of the top layer
      if (p && carry) carry = this.#join(p, carry);
      else if (p) carry = this.#dup(p);
      else if (carry) carry = this.#dup(carry);
    }
    this.done = carry.h;
    return this.done;
  }

  // Inclusion proof of a watched leaf, as merkle.mjs proof() returns it (sibling hashes, hex).
  proof(index) {
    if (!this.done) throw new Error("StreamMerkle: call root() first");
    const p = this.proofs.get(index);
    return p ? p.map((b) => b.toString("hex")) : null;
  }
}
