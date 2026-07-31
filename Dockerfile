# Deps installed with npm (Bun's fetcher misbehaves behind some resolvers;
# Bun still runs the TypeScript directly at runtime).
FROM node:22-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/concord-core/package.json packages/concord-core/
COPY packages/bridge/package.json packages/bridge/
COPY packages/portal/package.json packages/portal/
RUN npm install --no-audit --no-fund

# The portal SPA is built INSIDE the image so it always matches the source;
# the host's web/dist (if any) is excluded via .dockerignore.
FROM node:22-slim AS webbuild
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN node_modules/.bin/vite build packages/portal/web

FROM oven/bun:1
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
COPY --from=webbuild /app/packages/portal/web/dist ./packages/portal/web/dist
ENV NODE_ENV=production
CMD ["bun", "run", "packages/bridge/src/index.ts"]
