# Mars light time: JPL ION with its LTP convergence layer between two nodes whose link
# is delayed 4 minutes each way by netem. The ION build steps match ion/Dockerfile, so
# they come from the Docker cache.
FROM node:20-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends \
      git ca-certificates build-essential autoconf automake libtool pkg-config procps util-linux \
    && rm -rf /var/lib/apt/lists/*
ENV GIT_TERMINAL_PROMPT=0
RUN git clone --depth 1 https://github.com/nasa-jpl/ION-DTN.git /opt/ion \
    && git -C /opt/ion rev-parse --short HEAD > /opt/ion/COMMIT
WORKDIR /opt/ion
RUN ( [ -x ./configure ] || autoreconf -fi ) && ./configure --quiet && make -j2 >/dev/null && make install >/dev/null && ldconfig
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends iproute2 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY . /app
CMD ["bash", "/app/mars/run-mars.sh"]
