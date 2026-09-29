# JPL ION (Interplanetary Overlay Network) built from source, plus Node 20 for our
# custody agent. Two ION nodes run in one container, each in its own IPC namespace
# (ION keeps its state in SysV shared memory), so the container runs --privileged.
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
COPY . /app
CMD ["bash", "/app/ion/run-ion.sh"]
