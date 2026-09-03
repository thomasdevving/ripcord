# Ripcord webapp — one image, one service, one public port.
#
# Three stages, and the reasons they are separate:
#
#   foundry  fetches a PINNED anvil/cast for the target architecture and verifies
#            it against a checksum written into this file. Not `foundryup`, which
#            resolves to whatever is current at build time — a fork tool whose
#            version drifts between builds is a reproducibility hole in exactly
#            the component whose output we ask people to trust. Not a copy of the
#            developer's local binary either: that is a macOS Mach-O and will not
#            run here.
#
#   build    installs dev dependencies and compiles both the server and the
#            frontend. It never sees an RPC key: `vite build` inlines any VITE_*
#            variable into a public asset, so a build-time secret would ship to
#            every visitor. THE IMAGE MUST BE BUILDABLE WITH NO RPC KEY AT ALL,
#            the CI image smoke test enforces this without credentials.
#
#   runtime  carries only production dependencies, the compiled output and the
#            two Foundry binaries. It runs as a non-root user and starts the real
#            production entrypoint, never the Vite dev server.
#
# Only the web port is exposed. anvil is spawned transiently by a job worker,
# binds 127.0.0.1, and is never published or proxied — see src/fork/anvil.ts.

# --- Foundry (pinned + checksum-verified) ------------------------------------
FROM debian:bookworm-slim AS foundry

ARG FOUNDRY_VERSION=v1.8.1
# Checksums read from the release's own .sha256 assets and pinned HERE, so the
# verification does not simply re-download its own answer from the same place.
ARG FOUNDRY_SHA256_AMD64=37b45855232e57624d90113b049ca54f0c92055bb5c1997fcbdc3076c7b89c10
ARG FOUNDRY_SHA256_ARM64=27a32bd282d73018ab4d043de15ab0320b561c71b4bf3a549b130a0806e79f5c
# Supplied by BuildKit. Railway builds amd64; arm64 is here so a developer on an
# Apple Silicon machine can build and run the identical image locally.
ARG TARGETARCH

RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl \
 && rm -rf /var/lib/apt/lists/*

RUN set -eux; \
    case "${TARGETARCH}" in \
      amd64) arch=amd64; sha="${FOUNDRY_SHA256_AMD64}" ;; \
      arm64) arch=arm64; sha="${FOUNDRY_SHA256_ARM64}" ;; \
      *) echo "unsupported architecture: ${TARGETARCH}" >&2; exit 1 ;; \
    esac; \
    url="https://github.com/foundry-rs/foundry/releases/download/${FOUNDRY_VERSION}/foundry_${FOUNDRY_VERSION}_linux_${arch}.tar.gz"; \
    curl -fsSL "$url" -o /tmp/foundry.tar.gz; \
    echo "${sha}  /tmp/foundry.tar.gz" | sha256sum -c -; \
    mkdir -p /foundry; \
    tar -xzf /tmp/foundry.tar.gz -C /foundry anvil cast; \
    chmod +x /foundry/anvil /foundry/cast; \
    # Fail the BUILD, not the first job, if the binaries are unusable here.
    /foundry/anvil --version; \
    /foundry/cast --version

# --- build -------------------------------------------------------------------
FROM node:22-bookworm-slim AS build
WORKDIR /app

# corepack activates the pnpm version pinned by package.json's `packageManager`
# field, which is the single source of truth for it everywhere else too.
RUN corepack enable

# Dependency manifests first, so a source-only change does not re-resolve the
# whole tree on every build.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile

COPY tsconfig.json tsconfig.server.json vite.config.ts vitest.config.ts ./
COPY src ./src
COPY server ./server
COPY web ./web

# Deliberately no ARG/ENV for any RPC or API key: nothing in this stage reads
# one, and a VITE_* variable would be baked into a public asset.
RUN pnpm build:server && pnpm build:web

# Production dependency tree only, for the runtime stage.
RUN pnpm prune --prod

# --- runtime -----------------------------------------------------------------
FROM node:22-bookworm-slim AS runtime
WORKDIR /app

# ca-certificates is required for outbound HTTPS to the RPC provider.
# tini gives us correct PID-1 signal handling: without it SIGTERM does not reach
# Node, the manager's shutdown never runs, and a platform restart can leave an
# anvil child holding a port for the next boot.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates tini gosu \
 && rm -rf /var/lib/apt/lists/*

COPY --from=foundry /foundry/anvil /usr/local/bin/anvil
COPY --from=foundry /foundry/cast  /usr/local/bin/cast

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist-server ./dist-server
COPY --from=build /app/dist-web ./dist-web
COPY --from=build /app/package.json ./package.json

# Committed historical evidence, served read-only through the report routes.
# Copied explicitly rather than by mounting the repo, so the container never has
# a filesystem path into anything else.
COPY calibration/reports ./calibration/reports

# node:22 ships an unprivileged `node` user (uid 1000). /data is created and
# owned here so the app can write even when no volume is attached; when Railway
# mounts one, its ownership must match — see docs/RAILWAY.md, which explains how
# to check it.
RUN mkdir -p /data && chown -R node:node /data /app
COPY scripts/docker-entrypoint.sh /usr/local/bin/ripcord-entrypoint
RUN chmod 755 /usr/local/bin/ripcord-entrypoint

ENV NODE_ENV=production \
    PORT=8080 \
    RIPCORD_DATA_DIR=/data \
    RIPCORD_WEB_DIST=/app/dist-web \
    RIPCORD_CALIBRATION_DIR=/app/calibration/reports

# Only the web port. anvil binds loopback inside the container and is never
# published, so there is no public RPC proxy here.
EXPOSE 8080

# A build-time sanity check that the start path matches the compiled output. A
# documented start command that does not exist is the classic deployment
# failure, and this makes it a build failure instead of a 3am one.
RUN test -f /app/dist-server/server/index.js \
 && test -f /app/dist-server/server/jobs/worker.js \
 && test -f /app/dist-web/index.html

# tini reaps zombies and forwards signals; the CMD is the real production
# entrypoint, never the Vite dev server.
ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/ripcord-entrypoint"]
CMD ["node", "dist-server/server/index.js"]
