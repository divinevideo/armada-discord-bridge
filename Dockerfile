# Deps installed with npm (Bun's fetcher misbehaves behind some resolvers;
# Bun still runs the TypeScript directly at runtime).
FROM node:22-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/concord-core/package.json packages/concord-core/
COPY packages/bridge/package.json packages/bridge/
RUN npm install --no-audit --no-fund

FROM oven/bun:1
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
ENV NODE_ENV=production
CMD ["bun", "run", "packages/bridge/src/index.ts"]
