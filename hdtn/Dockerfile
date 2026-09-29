# NASA HDTN (High-rate DTN, NASA Glenn) built from source, plus Node 20 for our custody
# agent. Hardware-specific x86 options are off so the image builds on any x86 host.
FROM node:20-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends \
      git ca-certificates cmake build-essential libzmq3-dev libboost-all-dev openssl libssl-dev procps \
    && rm -rf /var/lib/apt/lists/*
ENV GIT_TERMINAL_PROMPT=0
RUN git clone --depth 1 https://github.com/nasa/HDTN.git /opt/HDTN
WORKDIR /opt/HDTN/build
RUN cmake .. -DCMAKE_BUILD_TYPE=Release -DUSE_X86_HARDWARE_ACCELERATION=OFF -DLTP_RNG_USE_RDSEED=OFF \
    && make -j"$(nproc)" hdtn-one-process bpsendfile bpreceivefile \
    && git -C /opt/HDTN rev-parse --short HEAD > /opt/HDTN/COMMIT
ENV HDTN_SOURCE_ROOT=/opt/HDTN
WORKDIR /app
COPY . /app
CMD ["bash", "/app/hdtn/run-hdtn.sh"]
