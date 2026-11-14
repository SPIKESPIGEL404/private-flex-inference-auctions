# syntax=docker/dockerfile:1.7
# A local cached Rust builder may be selected with --build-arg BUILDER_IMAGE.
# Only the resulting binary is copied into the clean runtime stage.
ARG BUILDER_IMAGE=rust@sha256:7c4ae649a84014c467d79319bbf17ce2632ae8b8be123ac2fb2ea5be46823f31
ARG NODE_IMAGE=node@sha256:dc26ae92c9fb15cf6b1d63e20f0944b2efe0f115b20e00be48fb23fceb061c54
FROM ${BUILDER_IMAGE} AS rustbuild
WORKDIR /src
RUN apt-get update && apt-get install -y --no-install-recommends pkg-config libssl-dev ca-certificates git && rm -rf /var/lib/apt/lists/*
COPY deploy/market/.build-cargo/git /usr/local/cargo/git
COPY .market-p2-upstream ./.market-p2-upstream
COPY crates/private-market-p2 ./crates/private-market-p2
COPY crates/private-market-host/src ./crates/private-market-host/src
COPY crates/private-market-host/upstream ./crates/private-market-host/upstream
ENV CARGO_NET_GIT_FETCH_WITH_CLI=true CARGO_BUILD_JOBS=2
RUN cargo build --locked --release --manifest-path crates/private-market-p2/Cargo.toml --bin private-market-host-p2 --target-dir /src/target

FROM ${NODE_IMAGE} AS assets
WORKDIR /app/clients/agent-playground
COPY clients/agent-playground/package*.json ./
RUN npm ci --ignore-scripts
COPY clients/agent-playground ./
RUN npm run build
WORKDIR /app/services/mpp-near-direct
COPY services/mpp-near-direct/package*.json ./
RUN npm ci --ignore-scripts --omit=dev

FROM ${NODE_IMAGE} AS runtime
RUN apt-get update && apt-get install -y --no-install-recommends python3 postgresql-15 redis-server ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd --gid 10001 preview && useradd --uid 10001 --gid 10001 --create-home preview \
    && mkdir /data && chown preview:preview /data
WORKDIR /app
COPY --from=rustbuild /src/target/release/private-market-host-p2 /usr/local/bin/private-market-host-p2
COPY --from=assets /app/clients/agent-playground/dist ./clients/agent-playground/dist
COPY services/mpp-near-direct ./services/mpp-near-direct
COPY --from=assets /app/services/mpp-near-direct/node_modules ./services/mpp-near-direct/node_modules
COPY scripts/*.py ./scripts/
ENV PATH=/usr/lib/postgresql/15/bin:$PATH P1_NODE=/usr/local/bin/node PYTHONDONTWRITEBYTECODE=1 NODE_OPTIONS=--max-old-space-size=384
USER preview:preview
EXPOSE 3000
HEALTHCHECK --start-period=120s --interval=15s --timeout=5s CMD node -e "fetch('http://127.0.0.1:3000/healthz').then(async r=>{let j=await r.json();if(!r.ok||!j.ready||j.realPayment!==false)process.exit(1)}).catch(()=>process.exit(1))"
ENTRYPOINT ["python3", "/app/scripts/serve-agent-mpp-preview.py"]
