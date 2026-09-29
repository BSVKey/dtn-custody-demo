# Mixed-implementation chain: uD3TN (D3TN) -> NASA HDTN -> uD3TN over TCPCLv3, the
# convergence layer both speak. The HDTN steps match hdtn/Dockerfile so they come from cache.
FROM node:20-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends \
      git ca-certificates cmake build-essential libzmq3-dev libboost-all-dev openssl libssl-dev procps \
    && rm -rf /var/lib/apt/lists/*
ENV GIT_TERMINAL_PROMPT=0
RUN git clone --depth 1 https://github.com/nasa/HDTN.git /opt/HDTN
WORKDIR /opt/HDTN/build
RUN cmake .. -DCMAKE_BUILD_TYPE=Release -DUSE_X86_HARDWARE_ACCELERATION=OFF -DLTP_RNG_USE_RDSEED=OFF \
    && make -j2 hdtn-one-process bpsendfile bpreceivefile \
    && git -C /opt/HDTN rev-parse --short HEAD > /opt/HDTN/COMMIT
ENV HDTN_SOURCE_ROOT=/opt/HDTN
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends \
      pkg-config python3 python3-pip python3-venv libsqlite3-dev libjansson-dev \
    && rm -rf /var/lib/apt/lists/*
RUN git clone --depth 1 --recurse-submodules https://gitlab.com/d3tn/ud3tn.git /opt/ud3tn \
    && cd /opt/ud3tn && make posix >/dev/null && git rev-parse --short HEAD > /opt/ud3tn/COMMIT
RUN pip3 install --break-system-packages ud3tn-utils || pip3 install ud3tn-utils
WORKDIR /app
COPY . /app
CMD ["bash", "/app/mix/run-mix.sh"]
