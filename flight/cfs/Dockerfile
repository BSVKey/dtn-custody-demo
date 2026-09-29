# NASA cFS (v7.0.1 bundle: cFE, OSAL, PSP and lab apps) built for native Linux with the
# CUSTODY app added, then run: self-test, commanded signing over the software bus, and a
# check of the records against the published test vectors. The mission definitions are
# cFE's sample_defs with the CUSTODY app added to the app list and startup script.
FROM node:22-trixie-slim
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates cmake build-essential curl \
    && rm -rf /var/lib/apt/lists/*
ENV GIT_TERMINAL_PROMPT=0
RUN git clone --depth 1 --branch v7.0.1 --recurse-submodules --shallow-submodules https://github.com/nasa/cFS.git /cfs
RUN mkdir /cfs/custody_defs && cp -r /cfs/cfe/cmake/sample_defs/. /cfs/custody_defs/ \
    && echo 'list(APPEND MISSION_GLOBAL_APPLIST custody)' >> /cfs/custody_defs/targets.cmake \
    && sed -i '/^CFE_APP, sample_app/a CFE_APP, custody,     CUSTODY_AppMain,    CUSTODY,      50,   16384, 0x0, 0;' /cfs/custody_defs/cpu1_cfe_es_startup.scr \
    && grep -n custody /cfs/custody_defs/targets.cmake /cfs/custody_defs/cpu1_cfe_es_startup.scr
# TweetNaCl, pinned by hash as in flight/Dockerfile.
RUN mkdir -p /opt/tweetnacl && cd /opt/tweetnacl \
    && curl -fsSLO https://tweetnacl.cr.yp.to/20140427/tweetnacl.c \
    && curl -fsSLO https://tweetnacl.cr.yp.to/20140427/tweetnacl.h \
    && echo "02e65bc3013ff2168983365e55906bc783c4c7e0a60d8100f17bb303a17175c4  tweetnacl.c" > SHA256SUMS \
    && echo "43f29ad721d9927b747b0100ab4160c119e7bb180c7c98a66e4bf79d31244287  tweetnacl.h" >> SHA256SUMS \
    && sha256sum -c SHA256SUMS
COPY flight/cfs/custody /cfs/apps/custody
COPY flight/custody.c flight/custody.h flight/sha256.c flight/sha256.h /cfs/apps/custody/fsw/src/
RUN cp /opt/tweetnacl/tweetnacl.c /opt/tweetnacl/tweetnacl.h /cfs/apps/custody/fsw/src/ \
    && cd /cfs && cmake -DCMAKE_BUILD_TYPE=Release -DSIMULATION=native -DCMAKE_INSTALL_PREFIX=/exe \
         -DMISSIONCONFIG=custody -DMISSION_DEFS=/cfs/custody_defs -B build -S cfe > /tmp/prep.log 2>&1 \
    && (find apps -name '*_topicids.h' -exec cp {} build/native/default/inc/ \; 2>/dev/null; true) \
    && (make -C build DESTDIR=/cfs/out -j2 mission-install > /tmp/make.log 2>&1 || (tail -60 /tmp/prep.log /tmp/make.log; exit 1)) \
    && ls /cfs/out/exe/cpu1
WORKDIR /app
COPY . /app
CMD ["bash", "/app/flight/cfs/run-cfs.sh"]
