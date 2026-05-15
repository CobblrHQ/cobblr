# Multi-stage Dockerfile for the cobblr-api service. Image is the
# source of truth at runtime — no bind mounts in compose.

# ─── builder ─────────────────────────────────────────────────────────
FROM node:22-alpine AS builder

WORKDIR /app

# Copy every workspace's package.json before installing so npm can
# resolve the symlinks without redoing the install on every source
# change. As new modules land, add their package.json copies here.
COPY package.json package-lock.json* tsconfig.base.json ./
COPY api/package.json ./api/
COPY web/package.json ./web/
COPY packages/platform-contract/package.json ./packages/platform-contract/
COPY packages/platform-web/package.json ./packages/platform-web/
COPY modules/inventory/package.json ./modules/inventory/
COPY modules/labels/package.json ./modules/labels/
COPY modules/projects/package.json ./modules/projects/
COPY modules/purchases/package.json ./modules/purchases/
COPY modules/machines/package.json ./modules/machines/
COPY modules/assets/package.json ./modules/assets/
COPY modules/3d-printers/package.json ./modules/3d-printers/
COPY modules/laser-cutters/package.json ./modules/laser-cutters/
COPY modules/cnc-machines/package.json ./modules/cnc-machines/
COPY modules/workshop-mods/package.json ./modules/workshop-mods/

RUN npm install --workspaces --include-workspace-root --no-audit --no-fund

# Source for every workspace the runtime needs.
COPY packages/platform-contract ./packages/platform-contract
# platform-web is only referenced by module UI code (e.g. inventory's
# PartDetailPage) — types resolve via tsc but never ship in the api
# runtime image. Source copy is still required for the inventory tsc
# build to satisfy the @cobblr/platform-web import.
COPY packages/platform-web ./packages/platform-web
COPY api ./api
COPY modules ./modules

# Build every module that has a build script. The loader's
# package.json#main resolution picks up dist/module.js at boot.
RUN npm run --if-present build -w @cobblr/inventory
RUN npm run --if-present build -w @cobblr/labels
RUN npm run --if-present build -w @cobblr/projects
RUN npm run --if-present build -w @cobblr/purchases
RUN npm run --if-present build -w @cobblr/machines
RUN npm run --if-present build -w @cobblr/assets
RUN npm run --if-present build -w @cobblr/3d-printers
RUN npm run --if-present build -w @cobblr/laser-cutters
RUN npm run --if-present build -w @cobblr/cnc-machines
RUN npm run --if-present build -w @cobblr/workshop-mods
WORKDIR /app/api
RUN npm run build

# ─── runtime ─────────────────────────────────────────────────────────
FROM node:22-alpine AS runtime

WORKDIR /app

ENV NODE_ENV=production

# Bring over what we need at runtime: built artifacts + the hoisted
# workspace node_modules. npm hoists into the root node_modules so
# there's no per-workspace install to copy.
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/api/dist ./api/dist
COPY --from=builder /app/api/migrations ./api/migrations
COPY --from=builder /app/api/package.json ./api/
COPY --from=builder /app/packages/platform-contract ./packages/platform-contract
# Each module ships its compiled dist/ + migrations/ alongside its
# package.json. The loader resolves package.json#main to dist/module.js.
COPY --from=builder /app/modules ./modules

EXPOSE 4000

WORKDIR /app/api

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD wget -qO- http://127.0.0.1:4000/api/v1/healthz || exit 1

CMD ["node", "dist/index.js"]
