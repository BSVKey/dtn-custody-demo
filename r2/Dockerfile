# R2: real BPv7 transport via uD3TN (D3TN). Builds uD3TN from source + its Python AAP
# utils, so our agent can send/receive bundles over real Bundle Protocol v7.
FROM debian:bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
      git ca-certificates build-essential pkg-config \
      python3 python3-pip python3-venv file iproute2 procps sqlite3 libsqlite3-dev libjansson-dev \
    && rm -rf /var/lib/apt/lists/*

ENV GIT_TERMINAL_PROMPT=0
RUN git clone --depth 1 --recurse-submodules https://gitlab.com/d3tn/ud3tn.git /opt/ud3tn
WORKDIR /opt/ud3tn
RUN make posix
ENV PATH="/opt/ud3tn/build/posix:${PATH}"
RUN pip3 install --break-system-packages ud3tn-utils || pip3 install ud3tn-utils

RUN apt-get update && apt-get install -y --no-install-recommends nodejs && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY . /app
CMD ["bash"]
