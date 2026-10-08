# Multi-platform index digest for Node 22.23.2 on Debian bookworm.
FROM node:22.23.2-bookworm-slim@sha256:48e4b67d85f87bd551df43704e24d252f56cc5f8e9718841aace50f19948f0f9 AS build
WORKDIR /app
COPY package.json package-lock.json .npmrc tsconfig.json tsconfig.base.json ./
COPY packages/ packages/
COPY scripts/prepare-pi.mjs scripts/prepare-pi.mjs
RUN npm ci --ignore-scripts && npm run build && npm prune --omit=dev --ignore-scripts && node scripts/prepare-pi.mjs

FROM node:22.23.2-bookworm-slim@sha256:48e4b67d85f87bd551df43704e24d252f56cc5f8e9718841aace50f19948f0f9 AS runtime
LABEL org.opencontainers.image.source="https://github.com/dudaanton/abele-node" \
      org.opencontainers.image.licenses="GPL-3.0-only" \
      org.opencontainers.image.title="AbeleNode"
# ps supports durable process-group supervision; tini reaps orphaned children.
RUN apt-get update && apt-get install -y --no-install-recommends git procps tini ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && install -d -m 0700 -o node -g node /home/node/.local/state/abele-node /workspaces
WORKDIR /app
COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules/ node_modules/
COPY --from=build /app/packages/ packages/
COPY scripts/container.mjs scripts/container.mjs
COPY LICENSE ./
# SDK resources are retained; no external provider CLI, credentials, Git history,
# tests, probes or dev dependencies.
RUN find packages -type d -name src -prune -exec rm -rf '{}' + \
    && find packages -type d -name tests -prune -exec rm -rf '{}' + \
    && find packages -type f -name '*.tsbuildinfo' -delete
ENV NODE_ENV=production HOME=/home/node
USER node
EXPOSE 7778
HEALTHCHECK --interval=10s --timeout=5s --start-period=10s --retries=3 \
    CMD ["node", "scripts/container.mjs", "healthcheck"]
ENTRYPOINT ["/usr/bin/tini", "--", "node", "scripts/container.mjs"]
CMD ["start"]
