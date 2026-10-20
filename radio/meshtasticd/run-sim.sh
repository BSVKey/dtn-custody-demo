#!/usr/bin/env bash
# Two Meshtastic nodes in Docker (meshtasticd, simulated radio), linked by Meshtastic's own UDP
# LAN mesh, with radio/cli.mjs on each: a payer and a gateway. Dry run, synthetic funding.
#
#   bash radio/meshtasticd/run-sim.sh
#
# Needs Docker, Node 18+, and the Python library: python -m pip install meshtastic
# Real Meshtastic firmware and the real bridge, but no LoRa airtime: packets cross by UDP.
set -euo pipefail
cd "$(dirname "$0")/../.."
IMG=meshtastic/meshtasticd:latest
WORK=$(mktemp -d)
command -v cygpath >/dev/null && WORK=$(cygpath -m "$WORK") # Git Bash: give Node a Windows path
cleanup() { [ -n "${GW:-}" ] && kill "$GW" 2>/dev/null || true; docker rm -f mesh-a mesh-b >/dev/null 2>&1 || true; docker network rm meshnet >/dev/null 2>&1 || true; rm -rf "$WORK"; }
trap cleanup EXIT

wait_node() { for _ in $(seq 30); do python -m meshtastic --host "127.0.0.1:$1" --info >/dev/null 2>&1 && return 0; sleep 2; done; echo "node on $1 did not come up"; exit 1; }

docker network create meshnet >/dev/null
docker run -d --name mesh-a --network meshnet -p 4403:4403 "$IMG" meshtasticd -s -h 0a:00:00:00:00:01 >/dev/null
docker run -d --name mesh-b --network meshnet -p 4404:4403 "$IMG" meshtasticd -s -h 0a:00:00:00:00:02 >/dev/null
wait_node 4403; wait_node 4404
# turn on the UDP LAN mesh; the node reboots to apply it (meshtasticd exits, so start it again)
for p in 4403 4404; do python -m meshtastic --host "127.0.0.1:$p" --set network.enabled_protocols 1 >/dev/null; done
sleep 10; docker start mesh-a mesh-b >/dev/null
wait_node 4403; wait_node 4404

# throwaway keys and a synthetic funding transaction
node --input-type=module -e "
import { writeFileSync } from 'node:fs';
import { PrivateKey } from '@bsv/sdk';
import { demoPayment } from './radio/run-demo.mjs';
const payer = PrivateKey.fromRandom(), gw = PrivateKey.fromRandom();
const { tx } = await demoPayment({ to: payer.toAddress(), sats: 5000 });
writeFileSync('$WORK/payer.wif', payer.toWif()); writeFileSync('$WORK/gateway.wif', gw.toWif());
writeFileSync('$WORK/fund.hex', tx.toHex()); writeFileSync('$WORK/gw.pub', gw.toPublicKey().toString());
"

node radio/cli.mjs gateway --host 127.0.0.1:4404 --key-file "$WORK/gateway.wif" --gap-ms 500 --nack-ms 5000 &
GW=$!
sleep 10
node radio/cli.mjs send --host 127.0.0.1:4403 --wif-file "$WORK/payer.wif" --fund-file "$WORK/fund.hex" \
  --to "$(node --input-type=module -e "import { PrivateKey } from '@bsv/sdk'; console.log(PrivateKey.fromRandom().toAddress())")" \
  --sats 1000 --gateway-pub "$(cat "$WORK/gw.pub")" --gap-ms 500 --wait-ms 15000
