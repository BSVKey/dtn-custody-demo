#!/usr/bin/env node
// TCP delay relay: listens on LISTEN, connects each client to TARGET, and holds every
// segment for DELAY ms in each direction. It adds propagation delay to a link on kernels
// without tc netem (run.sh uses netem when the kernel has it). Segments are queued and
// released strictly in arrival order, so jitter cannot reorder a TCP stream.
//   node relief/realnet/delay-relay.mjs 127.0.0.1:5224 10.10.4.2:4224 280 20
import net from "node:net";

const [listen, target, delayArg = "280", jitterArg = "0"] = process.argv.slice(2);
const [lh, lp] = listen.split(":"), [th, tp] = target.split(":");
const delay = Number(delayArg), jitter = Number(jitterArg);

// One FIFO per direction drained by a single timer: segments leave strictly in arrival
// order, each no earlier than its own release time.
function pipe(from, to) {
  const q = [];
  let timer = null, ended = false;
  const drain = () => {
    timer = null;
    while (q.length && q[0].at <= Date.now()) { const { d } = q.shift(); if (!to.destroyed) to.write(d); }
    if (q.length) timer = setTimeout(drain, q[0].at - Date.now());
    else if (ended) to.end();
  };
  from.on("data", (d) => {
    q.push({ d, at: Date.now() + delay + (jitter ? (Math.random() * 2 - 1) * jitter : 0) });
    if (!timer) timer = setTimeout(drain, Math.max(0, q[0].at - Date.now()));
  });
  from.on("end", () => { ended = true; if (!timer) drain(); });
  from.on("error", () => to.destroy());
}

net.createServer((client) => {
  const up = net.connect(Number(tp), th);
  up.on("error", () => client.destroy());
  client.on("error", () => up.destroy());
  pipe(client, up); pipe(up, client);
}).listen(Number(lp), lh, () => console.log(`delay-relay ${listen} -> ${target}: ${delay} ms +-${jitter} ms`));
