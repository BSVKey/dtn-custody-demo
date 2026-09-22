#!/usr/bin/env bash
# Build the 4-namespace veth chain and shape each link with `tc netem`.
#
#   src(10.0.1.1) --L1-- (10.0.1.2)a(10.0.2.1) --L2-- (10.0.2.2)b(10.0.3.1) --L3-- (10.0.3.2)dst
#
# Each hop is a network namespace; each link is a veth pair with netem (delay +
# reorder) on both ends. L2 (a<->b) is the link the occultation drops. Idempotent-ish:
# tears down prior namespaces first. Requires NET_ADMIN (run the container privileged).
set -euo pipefail

ONE_WAY_MS="${ONE_WAY_MS:-150}"     # per-link one-way delay
JITTER_MS="${JITTER_MS:-40}"        # delay jitter (drives reordering with netem)
REORDER_PCT="${REORDER_PCT:-5}"     # percent of packets reordered

for ns in n_src n_a n_b n_dst; do ip netns del "$ns" 2>/dev/null || true; done
for ns in n_src n_a n_b n_dst; do ip netns add "$ns"; ip -n "$ns" link set lo up; done

mk_link() { # ns_left if_left ip_left  ns_right if_right ip_right
  local nl="$1" il="$2" al="$3" nr="$4" ir="$5" ar="$6"
  ip link add "$il" netns "$nl" type veth peer name "$ir" netns "$nr"
  ip -n "$nl" addr add "$al/24" dev "$il"; ip -n "$nl" link set "$il" up
  ip -n "$nr" addr add "$ar/24" dev "$ir"; ip -n "$nr" link set "$ir" up
  # netem on both egress directions
  ip netns exec "$nl" tc qdisc add dev "$il" root netem delay "${ONE_WAY_MS}ms" "${JITTER_MS}ms" reorder "${REORDER_PCT}%" 50% || true
  ip netns exec "$nr" tc qdisc add dev "$ir" root netem delay "${ONE_WAY_MS}ms" "${JITTER_MS}ms" reorder "${REORDER_PCT}%" 50% || true
}

mk_link n_src veth_s 10.0.1.1  n_a   veth_as 10.0.1.2   # L1
mk_link n_a   veth_ab 10.0.2.1 n_b   veth_ba 10.0.2.2   # L2 (occulted)
mk_link n_b   veth_bd 10.0.3.1 n_dst veth_d  10.0.3.2   # L3

echo "netns + veth + netem up. L2 = veth_ab (in n_a) is the occulted link."
ip netns exec n_a tc qdisc show dev veth_ab
