# syntax=docker/dockerfile:1.7
# Controlled Market host image. Digests are pinned; buyers still cannot yet
# prove this image was built from the published source (reproducible builds
# are future work). Build from the repository root after staging private git
# deps:
#   bash scripts/prepare-market-docker-cargo.sh
#   docker build -f deploy/market/Dockerfile -t private-market-host:local .

ARG RUST_IMAGE=rust@sha256:7c4ae649a84014c467d79319bbf17ce2632ae8b8be123ac2fb2ea5be46823f31
ARG RUNTIME_IMAGE=debian@sha256:734a72b3d6142a71993b4bc580ca01d8ca687f77a2c422d96a961d3376b179bc

FROM ${RUST_IMAGE} AS build
WORKDIR /src
RUN apt-get update \
    && apt-get install -y --no-install-recommends pkg-config libssl-dev ca-certificates git \
    && rm -rf /var/lib/apt/lists/*
# Private git revisions are staged from the builder's cargo home. crates.io
# remains online. This does not embed GitHub credentials in the image.
COPY deploy/market/.build-cargo/git /usr/local/cargo/git
COPY crates/private-market-host/Cargo.toml crates/private-market-host/Cargo.lock ./
COPY crates/private-market-host/src ./src
COPY crates/private-market-host/upstream ./upstream
ENV CARGO_NET_GIT_FETCH_WITH_CLI=true
RUN cargo build --locked --release --bin private-market-host

FROM ${RUNTIME_IMAGE} AS runtime
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl openssl \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd --system --gid 10001 market \
    && useradd --system --uid 10001 --gid 10001 --home-dir /var/lib/market --create-home --shell /usr/sbin/nologin market
COPY --from=build /src/target/release/private-market-host /usr/local/bin/private-market-host
COPY deploy/market/entrypoint.sh /usr/local/bin/market-entrypoint.sh
# Golden deploy catalog: init-deploy and every serve byte-compare state to this file.
COPY deploy/market/catalog.json /etc/market/catalog.json
RUN chmod 0555 /usr/local/bin/private-market-host /usr/local/bin/market-entrypoint.sh \
    && chmod 0444 /etc/market/catalog.json \
    && mkdir -p /run/market-tls \
    && chown -R market:market /var/lib/market /run/market-tls
# Do not pre-create STATE_ROOT: Docker copies image content into an empty named
# volume on first mount, and init-deploy refuses any pre-existing state directory.
USER market:market
WORKDIR /var/lib/market
ENV HOME=/var/lib/market
ENTRYPOINT ["/usr/local/bin/market-entrypoint.sh"]
