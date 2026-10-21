# One-command entry points.
.PHONY: help demo radio voyager ion-voyager test spike spike-local clean

help:
	@echo "make test        - acceptance criteria (offline, deterministic, node --test)"
	@echo "make demo        - full pipeline over the in-process simulator, readable output"
	@echo "make spike-local - M0 R1 over a REAL socket transport + scripted occultation (no Docker)"
	@echo "make spike       - M0 R1 over real veths + tc netem + a real L2 blackout (needs Docker + privileged)"
	@echo "make r2          - R2: custody chain over REAL µD3TN BPv7, held across a contact gap (needs Docker)"
	@echo "make bpv7-block - custody receipts inside the BPv7 bundle, carried intact by unaware uD3TN nodes (needs Docker)"
	@echo "make bpv7-block-all - the same through NASA HDTN, JPL ION and Aalyria Hardy too, and uD3TN -> HDTN in one path (needs Docker)"
	@echo "make bpv7-bpsec-all - a BPSec payload BIB beside block 224 through all four stacks (needs Docker)"
	@echo "make bpv7-hardy-custodian - Hardy signs custody receipts natively (custody-receipt filter, local Hardy checkout; needs Docker)"
	@echo "make bpv7-bpsec-ion / bpv7-bpsec-ion-source - JPL ION (real crypto) accepts our BIB / signs one we verify"
	@echo "make radio       - pay over radio: BSV payment + signed receipt over a simulated lossy LoRa link (offline)"
	@echo "make live        - bind delivery to a REAL on-chain BSV settlement (WhatsOnChain; needs network)"
	@echo "make overhead   - Custody Receipt Block cost per GB, per link rate and per contact (docs/overhead-benchmark.md); overhead-c and overhead-arm64 add C and emulated ARM (Docker)"
	@echo "make clean       - remove run artifacts"

test:
	node --test

demo:
	node run-demo.mjs

# Pay over radio: offline-signed BSV payment over a simulated Meshtastic LoRa link, gateway receipt back.
radio:
	node radio/run-demo.mjs

voyager:
	node voyager/run-voyager.mjs

# Real JPL ION over LTP at Voyager's data rates (160 bps down, 16 bps up), with the light
# time capped at 240 s by netem. Reuses the Mars image. See voyager/ION-RESULTS.md.
ion-voyager:
	docker build -t dtn-custody-mars -f mars/Dockerfile .
	docker run --rm --privileged -e OWLT=240 -e RATE_DOWN_BPS=160 -e RATE_UP_BPS=16 -e SEG=1400 -e QTIME=60 \
	  -e PAYLOAD_REPEAT=2 -e CHUNK_SIZE=128 -e RECV_TIMEOUT_S=1800 -e WAIT_S=1800 \
	  -e TRANSPORT="JPL ION over LTP/UDP, netem 240 s each way, 160 bps down, 16 bps up" \
	  -v "$(CURDIR):/app" dtn-custody-mars bash /app/mars/run-mars.sh

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

# Custody Receipt Block (BPv7 extension block 224) through two unaware uD3TN nodes, one
# holding it across a contact gap. Reuses the R2 image. See transport/bpv7/RESULTS.md.
bpv7-block:
	docker build -t dtn-custody-r2 -f r2/Dockerfile .
	docker run --rm -v "$(CURDIR):/app" dtn-custody-r2 bash /app/transport/bpv7/interop/ud3tn-run.sh

# The same block through NASA HDTN (STCP), JPL ION (UDP CL) and Aalyria Hardy (gRPC CLA),
# each holding the bundle across a scheduled gap. Reuses the hdtn, ion and hardy images.
bpv7-block-hdtn:
	docker build -t dtn-custody-hdtn -f hdtn/Dockerfile .
	docker run --rm --entrypoint bash -v "$(CURDIR):/app" dtn-custody-hdtn /app/transport/bpv7/interop/hdtn-run.sh

bpv7-block-ion:
	docker build -t dtn-custody-ion -f ion/Dockerfile .
	docker run --rm --privileged --entrypoint bash -v "$(CURDIR):/app" dtn-custody-ion /app/transport/bpv7/interop/ion-run.sh

bpv7-block-hardy:
	docker build -t dtn-custody-hardy -f hardy/Dockerfile .
	docker run --rm --entrypoint bash -v "$(CURDIR):/app" dtn-custody-hardy /app/transport/bpv7/interop/hardy-run.sh

# One bundle across two implementations in one path: uD3TN -> NASA HDTN (held across a gap).
bpv7-block-mix:
	docker build -t dtn-custody-mix -f mix/Dockerfile .
	docker run --rm --entrypoint bash -v "$(CURDIR):/app" dtn-custody-mix /app/transport/bpv7/interop/mix-run.sh

# uD3TN rebuilt to emit Previous Node blocks, so the transit-gap audit can name it.
bpv7-block-prevnode:
	docker build -t dtn-custody-r2 -f r2/Dockerfile .
	docker build -t dtn-custody-r2-prevnode -f r2/Dockerfile.prevnode .
	docker run --rm -e BPSEC=1 -v "$(CURDIR):/app" dtn-custody-r2-prevnode bash /app/transport/bpv7/interop/ud3tn-run.sh
	docker run --rm -e BPSEC=1 -e RECEIPT=2 -v "$(CURDIR):/app" dtn-custody-r2-prevnode bash /app/transport/bpv7/interop/ud3tn-run.sh

# Block 224 (receipt v2) and a payload BIB across LTP between two ION nodes, with the
# Earth-Moon light time on the link (LunaNet's LTPCL option). Uses the Mars image (ION + iproute2).
bpv7-block-ion-ltp:
	docker build -t dtn-custody-mars -f mars/Dockerfile .
	docker run --rm --privileged --entrypoint bash -v "$(CURDIR):/app" dtn-custody-mars /app/transport/bpv7/interop/ion-ltp-run.sh

bpv7-block-all: bpv7-block bpv7-block-hdtn bpv7-block-ion bpv7-block-ion-ltp bpv7-block-hardy bpv7-block-mix

# A second implementation of the Custody Receipt Block inside a real BPA: Aalyria's Hardy
# built from a local checkout (HARDY_SRC) with the custody-receipt Egress Rewriter, which
# signs version 2 receipts. Checked both ways against receipt-v2.mjs. See RESULTS.md section 7.
HARDY_SRC ?= ../hardy-custody-receipt
bpv7-hardy-custodian:
	docker build -t dtn-custody-hardy -f hardy/Dockerfile .
	docker build -t dtn-custody-hardy-custodian --build-arg HARDY_REVISION=$$(git -C $(HARDY_SRC) rev-parse --short HEAD) -f transport/bpv7/interop/hardy-custodian/Dockerfile $(HARDY_SRC)
	docker run --rm --entrypoint bash -v "$(CURDIR):/app" dtn-custody-hardy-custodian /app/transport/bpv7/interop/hardy-custodian/run.sh

# BPSec (RFC 9172/9173): a payload BIB beside block 224. bpv7-bpsec-all carries it through
# the four unaware stacks (verified at our destination before and after hop 2 appends).
# The ION checks need ION built with real crypto (ion/Dockerfile.bpsec, Mbed TLS): ION as
# the acceptor of our BIB, and ION as the signer whose BIB our code verifies.
bpv7-bpsec-all:
	docker build -t dtn-custody-r2 -f r2/Dockerfile .
	docker run --rm -e BPSEC=1 -v "$(CURDIR):/app" dtn-custody-r2 bash /app/transport/bpv7/interop/ud3tn-run.sh
	docker build -t dtn-custody-hdtn -f hdtn/Dockerfile .
	docker run --rm -e BPSEC=1 --entrypoint bash -v "$(CURDIR):/app" dtn-custody-hdtn /app/transport/bpv7/interop/hdtn-run.sh
	docker build -t dtn-custody-ion -f ion/Dockerfile .
	docker run --rm -e BPSEC=1 --privileged --entrypoint bash -v "$(CURDIR):/app" dtn-custody-ion /app/transport/bpv7/interop/ion-run.sh
	docker build -t dtn-custody-hardy -f hardy/Dockerfile .
	docker run --rm -e BPSEC=1 --entrypoint bash -v "$(CURDIR):/app" dtn-custody-hardy /app/transport/bpv7/interop/hardy-run.sh

bpv7-bpsec-image:
	docker build -t dtn-custody-ion -f ion/Dockerfile .
	docker build -t dtn-custody-ion-bpsec -f ion/Dockerfile.bpsec .

bpv7-bpsec-ion: bpv7-bpsec-image
	docker run --rm --privileged --entrypoint bash -v "$(CURDIR):/app" dtn-custody-ion-bpsec /app/transport/bpv7/interop/ion-bpsec-run.sh

bpv7-bpsec-ion-source: bpv7-bpsec-image
	docker run --rm --privileged --entrypoint bash -v "$(CURDIR):/app" dtn-custody-ion-bpsec /app/transport/bpv7/interop/ion-bpsec-source-run.sh

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

# Our custody payload through Aalyria's Hardy (BPA + time-variant routing), attached through
# Hardy's gRPC application and CLA APIs. See hardy/RESULTS.md.
hardy:
	docker build -t dtn-custody-hardy -f hardy/Dockerfile .
	docker run --rm dtn-custody-hardy

# The same signer as a NASA cFS application (cFS v7.0.1): boots, self-tests against the
# published vectors, signs custody receipts on command over the software bus. See flight/cfs/.
cfs:
	docker build -t dtn-custody-cfs -f flight/cfs/Dockerfile .
	docker run --rm --sysctl fs.mqueue.msg_max=256 dtn-custody-cfs

# Our custody payload through JPL ION over LTP across a Mars-distance link (netem, 4 minutes
# each way). Takes about 10 minutes. See mars/RESULTS.md.
mars:
	docker build -t dtn-custody-mars -f mars/Dockerfile .
	docker run --rm --privileged -e OWLT=240 dtn-custody-mars

# Thousands of satellites: batch receipts, changing routes, outages, attacks.
constellation:
	node constellation/run.mjs

# Custody Receipt Block overhead for a high-throughput operator: per-bundle against batched
# receipts, bytes per GB, CPU per link rate, latency per contact. See docs/overhead-benchmark.md.
overhead:
	node bench/overhead.mjs
overhead-c:
	docker build -t dtn-custody-overhead -f bench/Dockerfile.overhead .
	docker run --rm dtn-custody-overhead
overhead-arm64:
	docker build --platform linux/arm64 -t dtn-custody-overhead:arm64 -f bench/Dockerfile.overhead .
	docker run --rm --platform linux/arm64 dtn-custody-overhead:arm64 --max-leaves 100000 --label "aarch64 under QEMU user-mode emulation (emulated, not flight hardware)"
