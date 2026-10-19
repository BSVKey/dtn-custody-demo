# Aalyria's Hardy BPA built from a local checkout with the custody-receipt filter
# (hardy-custody-receipt, an Egress Rewriter), on top of the dtn-custody-hardy image that
# carries Node and the gRPC client. The build context is the Hardy checkout:
#   docker build -t dtn-custody-hardy-custodian --build-arg HARDY_REVISION=<rev> \
#     -f transport/bpv7/interop/hardy-custodian/Dockerfile ../hardy-custody-receipt
FROM rust:1-slim-trixie AS build
RUN apt-get update && apt-get install -y --no-install-recommends build-essential protobuf-compiler libprotobuf-dev \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /build
COPY . .
RUN cargo test --locked -p hardy-custody-receipt \
    && cargo build --locked --release --bin hardy-bpa-server --no-default-features --features grpc,custody-receipt

FROM dtn-custody-hardy
ARG HARDY_REVISION=unknown
COPY --from=build /build/target/release/hardy-bpa-server /opt/custodian/hardy-bpa-server
RUN echo "$HARDY_REVISION" > /opt/custodian/HARDY_REVISION
