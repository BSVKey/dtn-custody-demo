# One-command entry points.
.PHONY: help demo test spike spike-local clean

help:
	@echo "make test        - acceptance criteria (offline, deterministic, node --test)"
	@echo "make demo        - full pipeline over the in-process simulator, readable output"
	@echo "make spike-local - M0 R1 over a REAL socket transport + scripted occultation (no Docker)"
	@echo "make spike       - M0 R1 over real veths + tc netem + a real L2 blackout (needs Docker + privileged)"
	@echo "make r2          - R2: custody chain over REAL µD3TN BPv7, held across a contact gap (needs Docker)"
	@echo "make clean       - remove run artifacts"

test:
	node --test

demo:
	node run-demo.mjs

# Validated here: real sockets, real store-and-forward, scripted occultation.
spike-local:
	node m0/run-local.mjs

# Same processes over real veths with tc netem and a REAL L2 loss window. Needs a
# Docker host with the engine running; the container runs privileged for netns/tc.
spike:
	docker build -t dtn-custody-m0 -f m0/Dockerfile .
	docker run --rm --privileged dtn-custody-m0

# R2: our custody agent over real BPv7 (µD3TN built from source), bundles held in
# µD3TN storage across a scheduled contact gap (real bundle custody).
r2:
	docker build -t dtn-custody-r2 -f r2/Dockerfile .
	docker run --rm dtn-custody-r2 bash /app/r2/run-r2.sh

clean:
	rm -rf run-output *.log *.pcap m0/.keys.json m0/.m0-config.json
