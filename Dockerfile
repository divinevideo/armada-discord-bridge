FROM oven/bun:1.3.10-slim@sha256:5d5863f35ad9b3acceee8dc134fb2b89f07831129eaeec81af2b19a23dabe3e0 AS deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/concord-core/package.json packages/concord-core/
COPY packages/bridge/package.json packages/bridge/
COPY packages/portal/package.json packages/portal/
COPY packages/moderation/package.json packages/moderation/
RUN bun install --ignore-scripts --frozen-lockfile

FROM deps AS webbuild
COPY packages/portal/web packages/portal/web
RUN bun node_modules/vite/bin/vite.js build packages/portal/web

FROM deps AS production-deps
RUN rm -rf node_modules && bun install --ignore-scripts --frozen-lockfile --production

FROM oven/bun:1.3.10-slim@sha256:5d5863f35ad9b3acceee8dc134fb2b89f07831129eaeec81af2b19a23dabe3e0 AS runtime
ARG VCS_REF
LABEL org.opencontainers.image.source="https://github.com/divinevideo/armada-discord-bridge" \
      org.opencontainers.image.revision=$VCS_REF \
      org.opencontainers.image.licenses="AGPL-3.0-only"
RUN groupadd -g 10001 bridge && useradd -u 10001 -g 10001 -m bridge
WORKDIR /app
COPY --from=production-deps /app/node_modules ./node_modules
COPY package.json LICENSE ./
COPY packages/concord-core packages/concord-core
COPY packages/bridge packages/bridge
COPY packages/moderation packages/moderation
COPY packages/portal/package.json packages/portal/package.json
COPY packages/portal/src packages/portal/src
COPY --from=webbuild /app/packages/portal/web/dist ./packages/portal/web/dist
ENV NODE_ENV=production
USER 10001:10001

FROM runtime AS portal
CMD ["bun", "run", "packages/portal/src/index.ts"]

FROM runtime AS moderation
CMD ["bun", "run", "packages/moderation/src/index.ts"]

FROM runtime AS bridge
CMD ["bun", "run", "packages/bridge/src/index.ts"]
