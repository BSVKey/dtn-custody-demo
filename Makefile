# One-command entry points (stubs; implemented per milestone in docs/BUILD-PLAN.md).
.PHONY: help demo up down test clean spike

help:
	@echo "make spike   - M0: bring up the 4-node BPv7 testbed and push one bundle end to end"
	@echo "make up       - start the testbed (docker-compose up)"
	@echo "make down     - stop the testbed"
	@echo "make demo     - full run: chunk -> Merkle -> custody -> occultation gap -> settlement"
	@echo "make test     - acceptance criteria (offline, deterministic)"
	@echo "make clean    - remove run artifacts"

spike:
	@echo "TODO M0: build dtn-node image, wire netem on L1..L3, send one bundle source->dest"

up:
	docker compose up -d

down:
	docker compose down

demo:
	@echo "TODO: end-to-end demo (see docs/BUILD-PLAN.md sections 2-4)"

test:
	@echo "TODO: acceptance criteria 1-6 (see docs/BUILD-PLAN.md section 3)"

clean:
	rm -rf run-output *.log *.pcap
