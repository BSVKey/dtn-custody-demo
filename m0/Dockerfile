# M0 netem testbed image: Node + iproute2 (ip/tc) so one privileged container can
# build the 4-namespace veth chain, shape the links with `tc netem`, and run the four
# node processes. Run with --privileged (or --cap-add=NET_ADMIN) for tc/netns.
FROM node:20-bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
      iproute2 procps iputils-ping \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY . /app

# The spike is pure-Node + node:crypto, no npm install needed.
ENTRYPOINT ["bash", "m0/run-spike.sh"]
