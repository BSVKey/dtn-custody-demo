# Relief field pilot kit: µD3TN (BPv7) built from source plus the relief node daemon, in one
# image. Every service in docker-compose.yml runs this image with a different NODE_NAME.
FROM ubuntu:24.04

RUN apt-get update && apt-get install -y --no-install-recommends \
      git ca-certificates build-essential pkg-config python3 python3-pip \
      libsqlite3-dev libjansson-dev sqlite3 nodejs curl \
    && rm -rf /var/lib/apt/lists/*

ENV GIT_TERMINAL_PROMPT=0
RUN git clone --depth 1 --recurse-submodules https://gitlab.com/d3tn/ud3tn.git /opt/ud3tn \
    && make -C /opt/ud3tn -j"$(nproc)" posix \
    && pip3 install --break-system-packages ud3tn-utils

WORKDIR /app
COPY package.json package-lock.json ./
COPY agent ./agent
COPY r2/aap.mjs ./r2/aap.mjs
COPY relief/kit ./relief/kit
RUN chmod +x relief/kit/docker/entrypoint.sh
ENTRYPOINT ["/app/relief/kit/docker/entrypoint.sh"]
