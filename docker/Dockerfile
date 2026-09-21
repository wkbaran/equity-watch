# equity-watch: the scheduled check-and-publish loop, for a Docker host.
#
# Build context is the repo root (docker-compose.yaml sets it):
#   docker build -f docker/Dockerfile -t equity-watch .
#
# Two directories, on purpose:
#   /app   the code: dist/, web/, scripts/, node_modules. Replaced by every rebuild.
#   /data  everything the CLI writes - alerts.json, revisits.json, holdings.json,
#          ops.log.jsonl, .cache/, site/, and the Schwab tokens (HOME=/data puts
#          them in /data/.equity_watch). This is the volume. The CLI reads it from
#          the working directory, while `web/` is found relative to dist/, which is
#          why the two can't simply share a folder.

FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:22-bookworm-slim
# tzdata so TZ shows in logs and report names; curl for the healthcheck ping.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl tzdata \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
COPY web ./web
COPY scripts/check-and-publish.sh ./scripts/
COPY analysis.config.json ./analysis.config.default.json
COPY docker/entrypoint.sh docker/run-loop.sh docker/healthcheck.sh ./docker/
# A Windows checkout can hand these over with CRLF endings, which Linux reads as
# "bad interpreter". .gitattributes prevents it; this makes the build immune anyway.
RUN sed -i 's/\r$//' scripts/check-and-publish.sh docker/*.sh \
 && chmod +x scripts/check-and-publish.sh docker/*.sh \
 && printf '#!/bin/sh\nexec node /app/dist/cli.js "$@"\n' > /usr/local/bin/equity-watch \
 && chmod +x /usr/local/bin/equity-watch \
 && mkdir /data \
 && chown node:node /data

ENV HOME=/data \
    EQUITY_WATCH_STATE_DIR=/data \
    TZ=America/Denver \
    NODE_ENV=production
WORKDIR /data
VOLUME /data

# Starts as root only to fix ownership of /data (files put there with `docker cp`
# arrive root-owned), then drops to the unprivileged `node` user.
ENTRYPOINT ["/app/docker/entrypoint.sh"]
CMD ["/app/docker/run-loop.sh"]

HEALTHCHECK --interval=5m --timeout=10s --start-period=10m --retries=1 \
  CMD ["/app/docker/healthcheck.sh"]
