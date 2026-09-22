# M0 spike

De-risk the two independent risks in the real testbed before the full BPv7 build:

- **R1 — transport + netem + occultation:** a chunked payload survives a link blackout
  via store-and-forward and reassembles + verifies over a *real* transport.
- **R2 — BPv7 agent:** µD3TN/dtn7-rs as the bundle agent (the follow-on; swapping it in
  does not change `agent/`, per `../transport/bpv7-adapter.md`).

This spike proves **R1**. It runs the real `agent/` code over a real socket transport
(`node.mjs`: source / relay / relay / dest as separate processes), through a scripted
occultation, and asserts the destination reassembled + verified the payload, the
custody chain holds, a gap object is produced, and delivery binds to the settlement.

## Two ways to run

### `make spike-local` (validated, no Docker)
Four processes on localhost. The occultation is app-level (the relay holds its
outbound queue during the window), since there is no real link to drop. This is the
fast, dependency-free proof and is what has been run and is green.

### `make spike` (real netem, needs a Docker host)
The *same* processes in four network namespaces joined by veth pairs, each link shaped
with `tc netem` (delay + reorder), and a **real** occultation: `occult.sh` sets
`netem loss 100%` on the L2 veth for a window. TCP retransmission carries the held
bundles through once it clears (BPv7 custody store-and-forward is the µD3TN step that
replaces TCP's retransmit with application custody). Requires Docker running and a
privileged container (netns + tc need `NET_ADMIN`). Not yet executed in this
environment (the local variant is the validated proof); the logic mirrors it.

## Files
- `node.mjs`        one process, role = source | relaya | relayb | dest, over TCP.
- `run-local.mjs`   spawns the four processes on localhost (make spike-local).
- `Dockerfile`      Node + iproute2 image for the netem run.
- `net-setup.sh`    build the 4-namespace veth chain + netem shaping.
- `occult.sh`       drive a real 100%-loss blackout on L2 for a window.
- `run-spike.sh`    container entrypoint (make spike): setup, launch, occult, verdict.
- `config.docker.json`  hosts/ports/occultation for the netem run.

`.keys.json` and `.m0-config.json` are generated per run and gitignored.
