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
COPY modules/core-recurrence/package.json ./modules/core-recurrence/
COPY modules/core-activity-log/package.json ./modules/core-activity-log/
COPY modules/core-notifications/package.json ./modules/core-notifications/
COPY modules/core-healthcheck/package.json ./modules/core-healthcheck/
COPY modules/core-tags/package.json ./modules/core-tags/
COPY modules/core-views/package.json ./modules/core-views/
COPY modules/core-files/package.json ./modules/core-files/
COPY modules/core-search/package.json ./modules/core-search/
COPY modules/core-public-surfaces/package.json ./modules/core-public-surfaces/
COPY modules/core-openapi/package.json ./modules/core-openapi/
COPY modules/core-queue/package.json ./modules/core-queue/
COPY modules/core-locations/package.json ./modules/core-locations/
COPY modules/core-catalogs/package.json ./modules/core-catalogs/
COPY modules/core-labels-qr/package.json ./modules/core-labels-qr/
COPY modules/core-integrations/package.json ./modules/core-integrations/
COPY modules/core-ai/package.json ./modules/core-ai/
COPY modules/core-maintenance/package.json ./modules/core-maintenance/
COPY modules/core-units/package.json ./modules/core-units/
COPY modules/core-templates/package.json ./modules/core-templates/
COPY modules/core-scan/package.json ./modules/core-scan/
COPY modules/core-apps/package.json ./modules/core-apps/
COPY modules/core-authoring/package.json ./modules/core-authoring/
COPY modules/lists/package.json ./modules/lists/
COPY modules/tracking/package.json ./modules/tracking/
COPY modules/digifab/package.json ./modules/digifab/
COPY modules/core-file-preview/package.json ./modules/core-file-preview/
COPY modules/bricklink-connector/package.json ./modules/bricklink-connector/
# v0.3 sandbox SDK + AS sample module. Workspace-resolved so the
# AS author repo (sandboxed-modules/hello-as) sees the SDK at build
# time. The api runtime doesn't import these — only the AS toolchain.
COPY packages/sandbox-sdk-as/package.json ./packages/sandbox-sdk-as/
COPY sandboxed-modules/hello-as/package.json ./sandboxed-modules/hello-as/

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

# Marketplace v2: fetch/verify registry-sourced modules + record the
# manifest of every baked-in marketplace module. `source: "vendored"`
# entries are no-ops (modules/ COPY put them in place); `source:
# "registry"` entries are downloaded, sha256+ed25519 verified, and
# extracted to modules/<name>/. See docs/modules/marketplace.md.
COPY cobblr-modules.json ./cobblr-modules.json
COPY scripts ./scripts

# Marketplace v0.3 sandboxed modules. Each subdir has a manifest.json
# + a module.wasm built ahead of time (the kernel doesn't compile wasm
# at boot). The sandbox loader scans this dir at api boot and
# registers each entry as a synthetic module with wasm-backed routes.
# See docs/architecture/module-isolation.md.
COPY sandboxed-modules ./sandboxed-modules
RUN node scripts/install-registry-modules.mjs

# Build every module that has a build script. The loader's
# package.json#main resolution picks up dist/module.js at boot.
RUN npm run --if-present build -w @cobblr/inventory
RUN npm run --if-present build -w @cobblr/labels
RUN npm run --if-present build -w @cobblr/projects
RUN npm run --if-present build -w @cobblr/purchases
RUN npm run --if-present build -w @cobblr/machines
RUN npm run --if-present build -w @cobblr/assets
RUN npm run --if-present build -w @cobblr/core-recurrence
RUN npm run --if-present build -w @cobblr/core-activity-log
RUN npm run --if-present build -w @cobblr/core-notifications
RUN npm run --if-present build -w @cobblr/core-healthcheck
RUN npm run --if-present build -w @cobblr/core-tags
RUN npm run --if-present build -w @cobblr/core-views
RUN npm run --if-present build -w @cobblr/core-files
RUN npm run --if-present build -w @cobblr/core-search
RUN npm run --if-present build -w @cobblr/core-public-surfaces
RUN npm run --if-present build -w @cobblr/core-openapi
RUN npm run --if-present build -w @cobblr/core-queue
RUN npm run --if-present build -w @cobblr/core-locations
RUN npm run --if-present build -w @cobblr/core-catalogs
RUN npm run --if-present build -w @cobblr/core-labels-qr
RUN npm run --if-present build -w @cobblr/core-integrations
RUN npm run --if-present build -w @cobblr/core-ai
RUN npm run --if-present build -w @cobblr/core-maintenance
RUN npm run --if-present build -w @cobblr/core-units
RUN npm run --if-present build -w @cobblr/core-templates
RUN npm run --if-present build -w @cobblr/core-scan
RUN npm run --if-present build -w @cobblr/core-apps
RUN npm run --if-present build -w @cobblr/core-authoring
RUN npm run --if-present build -w @cobblr/lists
RUN npm run --if-present build -w @cobblr/tracking
RUN npm run --if-present build -w @cobblr/digifab
RUN npm run --if-present build -w @cobblr/core-file-preview
RUN npm run --if-present build -w @cobblr/bricklink-connector
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
# Sandboxed wasm modules (marketplace v0.3). Each subdir has a
# manifest.json + module.wasm; the sandbox loader picks them up.
COPY --from=builder /app/sandboxed-modules ./sandboxed-modules
# Manifest of every baked-in marketplace module — consumed at api
# boot to populate the installed_modules table.
COPY --from=builder /app/installed-modules.manifest.json ./installed-modules.manifest.json

EXPOSE 4000

WORKDIR /app/api

HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
  CMD wget -qO- http://127.0.0.1:4000/api/v1/healthz || exit 1
# start_period=60s covers cold boot: tenant DB provisioning catch-up
# + module migrations + the sandbox loader scanning both image-baked
# and runtime-installed wasm modules. 15s was tight even on the
# workshop box — boots over that frequently get marked unhealthy
# transiently, which trips Watchtower into a reload loop.

CMD ["node", "dist/index.js"]
