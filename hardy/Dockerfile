# Aalyria's Hardy (BPv7, Rust) BPA server, time-variant routing agent and bundle tools,
# taken from the published images (pinned by digest, Hardy revision 0da2247), plus Node
# and a gRPC client for our custody agent. Hardy's binaries target Debian 13, so the base matches.
FROM ghcr.io/ricktaylor/hardy/hardy-bpa-server@sha256:e0a8d129ec62111213a5c30020c1554e111752d118604085d06522f6020a2ef7 AS bpa
FROM ghcr.io/ricktaylor/hardy/hardy-tvr@sha256:a0e2162b7b9bc5465b6430a63e3ef74d30a59246361d25dd7af0730aa00d4730 AS tvr
FROM ghcr.io/ricktaylor/hardy/hardy-tools@sha256:9660d29bc5e247aeb296800aa1bbf69e7242025320366af6b8037c0b37542d12 AS tools
FROM node:22-trixie-slim
COPY --from=bpa /usr/local/bin/hardy-bpa-server /usr/local/bin/
COPY --from=tvr /usr/local/bin/hardy-tvr /usr/local/bin/
COPY --from=tools /usr/local/bin/bundle /usr/local/bin/
RUN echo 0da2247 > /opt/HARDY_REVISION \
    && mkdir -p /opt/grpc && cd /opt/grpc && npm init -y >/dev/null \
    && npm install --silent @grpc/grpc-js@1 @grpc/proto-loader@0 \
    && npm ls --depth=0
WORKDIR /app
COPY . /app
CMD ["bash", "/app/hardy/run-hardy.sh"]
