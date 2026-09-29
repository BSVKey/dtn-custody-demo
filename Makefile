# One-command entry points.
.PHONY: help demo test spike spike-local clean

help:
	@echo "make test        - acceptance criteria (offline, deterministic, node --test)"
	@echo "make demo        - full pipeline over the in-process simulator, readable output"
	@echo "make spike-local - M0 R1 over a REAL socket transport + scripted occultation (no Docker)"
	@echo "make spike       - M0 R1 over real veths + tc netem + a real L2 blackout (needs Docker + privileged)"
	@echo "make r2          - R2: custody chain over REAL µD3TN BPv7, held across a contact gap (needs Docker)"
	@echo "make live        - bind delivery to a REAL on-chain BSV settlement (WhatsOnChain; needs network)"
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

# Same harness at real Earth-Moon light time: lander-orbiter 20 ms, orbiter-Earth
# 1300 ms (the 1.28 s light time), ground 50 ms, with a 20 s blackout on the Earth link.
spike-moon:
	docker build -t dtn-custody-m0 -f m0/Dockerfile .
	docker run --rm --privileged -e M0_CFG=m0/config.moon.json -e L1_MS=20 -e L2_MS=1300 -e L3_MS=50 -e JITTER_MS=5 -e DOWN_AT_MS=6000 -e WINDOW_MS=20000 dtn-custody-m0

# R2: our custody agent over real BPv7 (µD3TN built from source), bundles held in
# µD3TN storage across a scheduled contact gap (real bundle custody).
r2:
	docker build -t dtn-custody-r2 -f r2/Dockerfile .
	docker run --rm dtn-custody-r2 bash /app/r2/run-r2.sh

# Live: bind the delivery to a real, on-chain-verified BSV settlement (read-only).
live:
	node live/run-live.mjs

clean:
	rm -rf run-output *.log *.pcap m0/.keys.json m0/.m0-config.json

# Our custody payload through JPL ION (built from source), two ION nodes, contact graph
# routing over a compiled plan with a scheduled 20 s gap. See ion/RESULTS.md.
ion:
	docker build -t dtn-custody-ion -f ion/Dockerfile .
	docker run --rm --privileged dtn-custody-ion

# Mixed implementations: uD3TN -> NASA HDTN -> uD3TN over TCPCLv3, with HDTN holding the
# bundles across a scheduled gap. See mix/RESULTS.md.
mix:
	docker build -t dtn-custody-mix -f mix/Dockerfile .
	docker run --rm dtn-custody-mix

# Onboard signing in C (TweetNaCl Ed25519): reproduces the published test vectors byte for
# byte, times signing, and sizes the code for an ARM Cortex-M4. See flight/RESULTS.md.
flight:
	docker build -t dtn-custody-flight -f flight/Dockerfile .
	docker run --rm dtn-custody-flight
