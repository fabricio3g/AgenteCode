# Agente Server: `agente serve` headless, for bots, routines and remote
# clients (Agente Desktop, `agente attach --remote`).
#
#   docker build -f docker/Dockerfile -t agente-server .
#   docker run -d -p 127.0.0.1:7420:7420 -e AGENTE_TOKEN=... \
#     -e OPENROUTER_API_KEY=... -v agente-data:/home/agente/.agente agente-server
#
# See docs/SERVER.md.

FROM rust:1-bookworm AS build
WORKDIR /src
COPY Cargo.toml Cargo.lock ./
COPY crates crates
COPY assets/brand assets/brand
RUN --mount=type=cache,target=/usr/local/cargo/registry \
    --mount=type=cache,target=/src/target \
    cargo build --release --locked --bin agente \
    && cp target/release/agente /usr/local/bin/agente

FROM debian:bookworm-slim
# What the agent's tools reach for: a shell, git, curl, ripgrep and ssh.
# tini runs as PID 1 so signals reach agente and finished processes are reaped.
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        bash ca-certificates curl git openssh-client procps ripgrep tini \
    && rm -rf /var/lib/apt/lists/* \
    && useradd --create-home --uid 1000 --shell /bin/bash agente \
    && mkdir -p /workspace /home/agente/.agente \
    && chown agente:agente /workspace /home/agente/.agente
COPY --from=build /usr/local/bin/agente /usr/local/bin/agente

USER agente
WORKDIR /workspace
ENV HOME=/home/agente \
    XDG_RUNTIME_DIR=/home/agente/.agente/run
# Settings, sessions, bots and the token live here: keep it on a volume.
VOLUME ["/home/agente/.agente"]
EXPOSE 7420

HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
    CMD ["agente", "serve", "--status"]

ENTRYPOINT ["/usr/bin/tini", "--", "agente"]
CMD ["serve", "--listen", "0.0.0.0:7420"]
