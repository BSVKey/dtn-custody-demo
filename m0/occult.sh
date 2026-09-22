#!/usr/bin/env bash
# Scripted occultation on L2 (the a<->b link): after DOWN_AT_MS, apply 100% loss on
# veth_ab for WINDOW_MS, then restore the shaping. A REAL link blackout; TCP
# retransmission carries the held bundles through once it clears (BPv7 custody
# store-and-forward is the uD3TN step that replaces TCP's retransmit with app custody).
set -euo pipefail
DOWN_AT_MS="${DOWN_AT_MS:-800}"
WINDOW_MS="${WINDOW_MS:-3000}"
ONE_WAY_MS="${ONE_WAY_MS:-150}"; JITTER_MS="${JITTER_MS:-40}"; REORDER_PCT="${REORDER_PCT:-5}"

sleep "$(awk "BEGIN{print $DOWN_AT_MS/1000}")"
echo "[occult] L2 DOWN (100% loss on veth_ab) for ${WINDOW_MS}ms"
ip netns exec n_a tc qdisc change dev veth_ab root netem loss 100%
sleep "$(awk "BEGIN{print $WINDOW_MS/1000}")"
ip netns exec n_a tc qdisc change dev veth_ab root netem delay "${ONE_WAY_MS}ms" "${JITTER_MS}ms" reorder "${REORDER_PCT}%" 50%
echo "[occult] L2 UP (shaping restored)"
