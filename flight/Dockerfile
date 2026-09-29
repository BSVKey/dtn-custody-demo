# Onboard custody signing in C: build, reproduce the published test vectors byte for byte,
# time signing, and measure code size for an ARM Cortex-M4 flight-class target.
FROM node:20-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends \
      build-essential curl ca-certificates gcc-arm-none-eabi libnewlib-arm-none-eabi \
    && rm -rf /var/lib/apt/lists/*
# TweetNaCl (public domain, tweetnacl.cr.yp.to, release 20140427), fetched from its
# authors' site and pinned by hash: a changed file fails the build.
RUN mkdir -p /opt/tweetnacl && cd /opt/tweetnacl \
    && curl -fsSLO https://tweetnacl.cr.yp.to/20140427/tweetnacl.c \
    && curl -fsSLO https://tweetnacl.cr.yp.to/20140427/tweetnacl.h \
    && echo "02e65bc3013ff2168983365e55906bc783c4c7e0a60d8100f17bb303a17175c4  tweetnacl.c" > SHA256SUMS \
    && echo "43f29ad721d9927b747b0100ab4160c119e7bb180c7c98a66e4bf79d31244287  tweetnacl.h" >> SHA256SUMS \
    && sha256sum -c SHA256SUMS
WORKDIR /app
COPY . /app
CMD ["bash", "/app/flight/run-flight.sh"]
