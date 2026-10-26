// Disk spool: bundles waiting for the DTN peer. One file per bundle, written to a temp
// name and renamed so a crash never leaves half a bundle. A bundle is deleted only after
// the peer has acknowledged every byte, so a dropped link or a restarted gateway resends
// whatever was still waiting, in the order it arrived.
import { mkdirSync, writeFileSync, renameSync, readdirSync, readFileSync, unlinkSync, existsSync } from "node:fs";
import { join } from "node:path";

export class Spool {
  constructor(dir) {
    this.dir = dir;
    mkdirSync(dir, { recursive: true });
    const seqs = readdirSync(dir).filter((f) => f.endsWith(".bundle")).map((f) => Number(f.split(".")[0]));
    this.seq = seqs.length ? Math.max(...seqs) + 1 : 1;
  }

  add(bytes) {
    const name = `${String(this.seq++).padStart(12, "0")}.bundle`;
    const tmp = join(this.dir, `${name}.tmp`);
    writeFileSync(tmp, bytes);
    renameSync(tmp, join(this.dir, name));
    return name;
  }

  // Waiting bundles, oldest first.
  list() {
    return readdirSync(this.dir).filter((f) => f.endsWith(".bundle")).sort();
  }

  read(name) { return readFileSync(join(this.dir, name)); }

  done(name) {
    const p = join(this.dir, name);
    if (existsSync(p)) unlinkSync(p);
  }

  get size() { return this.list().length; }
}
