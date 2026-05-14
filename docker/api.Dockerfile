# Multi-stage Dockerfile for the cobblr-api service.
# Same shape as companion app's pattern — no bind mounts in compose, the
# image is the source of truth at runtime.

# ─── builder ─────────────────────────────────────────────────────────
FROM node:22-alpine AS builder

WORKDIR /app

# Copy workspace skeleton first so npm can resolve workspace links
# without redoing the install when only source changes.
COPY package.json package-lock.json* tsconfig.base.json ./
COPY api/package.json ./api/
COPY web/package.json ./web/
COPY packages/platform-contract/package.json ./packages/platform-contract/

RUN npm install --workspaces --include-workspace-root --no-audit --no-fund

# Now the source for the api + the platform-contract package it depends on.
# modules/ comes along so the loader has its scan target in the builder
# stage too (the runtime stage re-copies the same content).
COPY packages/platform-contract ./packages/platform-contract
COPY api ./api
COPY modules ./modules

WORKDIR /app/api
RUN npm run build

# ─── runtime ─────────────────────────────────────────────────────────
FROM node:22-alpine AS runtime

WORKDIR /app

ENV NODE_ENV=production

# Bring over only what we need to run: built artifacts + the
# workspace's resolved node_modules. npm hoists everything to the
# root node_modules, so there's no per-workspace node_modules to copy.
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/api/dist ./api/dist
COPY --from=builder /app/api/migrations ./api/migrations
COPY --from=builder /app/api/package.json ./api/
COPY --from=builder /app/packages/platform-contract ./packages/platform-contract
# modules/ may be empty (Phase 0) — copy whatever's there so the
# loader has something to scan at runtime.
COPY --from=builder /app/modules ./modules

EXPOSE 4000

WORKDIR /app/api

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD wget -qO- http://127.0.0.1:4000/api/v1/healthz || exit 1

CMD ["node", "dist/index.js"]
