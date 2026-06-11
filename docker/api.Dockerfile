# syntax=docker/dockerfile:1
# Multi-stage Dockerfile for the cobblr-api service. Image is the
# source of truth at runtime — no bind mounts in compose.
# BuildKit is enabled in CI (docker-build.yml) so the npm-cache mount below
# persists npm's download cache across builds — installs don't re-fetch tarballs.

# ─── builder ─────────────────────────────────────────────────────────
FROM node:22-alpine AS builder

WORKDIR /app

# Toolchain for native deps (bcrypt): node-pre-gyp fetches a musl prebuilt,
# but a transient fetch miss falls back to a source build that needs Python +
# a C++ compiler. Cheap insurance against "gyp ERR! find Python" build deaths.
RUN apk add --no-cache python3 make g++

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
COPY modules/core-print/package.json ./modules/core-print/
# v0.3 sandbox SDK + AS sample module. Workspace-resolved so the
# AS author repo (sandboxed-modules/hello-as) sees the SDK at build
# time. The api runtime doesn't import these — only the AS toolchain.
COPY packages/sandbox-sdk-as/package.json ./packages/sandbox-sdk-as/
COPY sandboxed-modules/hello-as/package.json ./sandboxed-modules/hello-as/

RUN --mount=type=cache,target=/root/.npm \
    npm install --workspaces --include-workspace-root --no-audit --no-fund

# Source for every workspace the runtime needs.
COPY packages/platform-contract ./packages/platform-contract
# platform-web is only referenced by module UI code (e.g. inventory's
# PartDetailPage) — types resolve via tsc but never ship in the api
# runtime image. Source copy is still required for the inventory tsc
# build to satisfy the @cobblr/platform-web import.
COPY packages/platform-web ./packages/platform-web

# Per-module COPY+build, each its own cache layer: a change to ONE module
# only invalidates that module (and the ones listed after it) instead of
# rebuilding all 34. Modules are isolated — none imports another — so build
# order is free; only platform-contract / platform-web must precede them
# (they do). Ordered stable-first / actively-developed-last so a typical
# commit re-runs just the last few layers. When adding a module, drop its
# COPY+RUN pair in (hot ones near the bottom).
COPY modules/labels ./modules/labels
RUN npm run --if-present build -w @cobblr/labels
COPY modules/projects ./modules/projects
RUN npm run --if-present build -w @cobblr/projects
COPY modules/purchases ./modules/purchases
RUN npm run --if-present build -w @cobblr/purchases
COPY modules/machines ./modules/machines
RUN npm run --if-present build -w @cobblr/machines
COPY modules/assets ./modules/assets
RUN npm run --if-present build -w @cobblr/assets
COPY modules/core-recurrence ./modules/core-recurrence
RUN npm run --if-present build -w @cobblr/core-recurrence
COPY modules/core-activity-log ./modules/core-activity-log
RUN npm run --if-present build -w @cobblr/core-activity-log
COPY modules/core-notifications ./modules/core-notifications
RUN npm run --if-present build -w @cobblr/core-notifications
COPY modules/core-healthcheck ./modules/core-healthcheck
RUN npm run --if-present build -w @cobblr/core-healthcheck
COPY modules/core-tags ./modules/core-tags
RUN npm run --if-present build -w @cobblr/core-tags
COPY modules/core-views ./modules/core-views
RUN npm run --if-present build -w @cobblr/core-views
COPY modules/core-files ./modules/core-files
RUN npm run --if-present build -w @cobblr/core-files
COPY modules/core-search ./modules/core-search
RUN npm run --if-present build -w @cobblr/core-search
COPY modules/core-public-surfaces ./modules/core-public-surfaces
RUN npm run --if-present build -w @cobblr/core-public-surfaces
COPY modules/core-openapi ./modules/core-openapi
RUN npm run --if-present build -w @cobblr/core-openapi
COPY modules/core-queue ./modules/core-queue
RUN npm run --if-present build -w @cobblr/core-queue
COPY modules/core-locations ./modules/core-locations
RUN npm run --if-present build -w @cobblr/core-locations
COPY modules/core-catalogs ./modules/core-catalogs
RUN npm run --if-present build -w @cobblr/core-catalogs
COPY modules/core-labels-qr ./modules/core-labels-qr
RUN npm run --if-present build -w @cobblr/core-labels-qr
COPY modules/core-integrations ./modules/core-integrations
RUN npm run --if-present build -w @cobblr/core-integrations
COPY modules/core-maintenance ./modules/core-maintenance
RUN npm run --if-present build -w @cobblr/core-maintenance
COPY modules/core-units ./modules/core-units
RUN npm run --if-present build -w @cobblr/core-units
COPY modules/core-templates ./modules/core-templates
RUN npm run --if-present build -w @cobblr/core-templates
COPY modules/core-file-preview ./modules/core-file-preview
RUN npm run --if-present build -w @cobblr/core-file-preview
COPY modules/bricklink-connector ./modules/bricklink-connector
RUN npm run --if-present build -w @cobblr/bricklink-connector
COPY modules/core-print ./modules/core-print
RUN npm run --if-present build -w @cobblr/core-print
# ── actively-developed (hot) modules last — their edits rebuild fewest layers ──
COPY modules/digifab ./modules/digifab
RUN npm run --if-present build -w @cobblr/digifab
COPY modules/inventory ./modules/inventory
RUN npm run --if-present build -w @cobblr/inventory
COPY modules/lists ./modules/lists
RUN npm run --if-present build -w @cobblr/lists
COPY modules/tracking ./modules/tracking
RUN npm run --if-present build -w @cobblr/tracking
COPY modules/core-scan ./modules/core-scan
RUN npm run --if-present build -w @cobblr/core-scan
COPY modules/core-apps ./modules/core-apps
RUN npm run --if-present build -w @cobblr/core-apps
COPY modules/core-ai ./modules/core-ai
RUN npm run --if-present build -w @cobblr/core-ai
COPY modules/core-authoring ./modules/core-authoring
RUN npm run --if-present build -w @cobblr/core-authoring

# Marketplace v2: fetch/verify registry-sourced modules + record the
# manifest of every baked-in marketplace module. `source: "vendored"`
# entries are no-ops (the per-module COPYs above put them in place);
# `source: "registry"` entries are downloaded, sha256+ed25519 verified,
# and extracted to modules/<name>/. See docs/modules/marketplace.md.
# Runs AFTER the per-module builds: it depends only on cobblr-modules.json
# + scripts (rarely changed), so a module source edit doesn't re-run it.
COPY cobblr-modules.json ./cobblr-modules.json
COPY scripts ./scripts
# Marketplace v0.3 sandboxed modules. Each subdir has a manifest.json
# + a module.wasm built ahead of time (the kernel doesn't compile wasm
# at boot). The sandbox loader scans this dir at api boot and
# registers each entry as a synthetic module with wasm-backed routes.
# See docs/architecture/module-isolation.md.
COPY sandboxed-modules ./sandboxed-modules
RUN node scripts/install-registry-modules.mjs

# api last: an api-only change rebuilds just the api, not the 34 modules.
COPY api ./api
WORKDIR /app/api
RUN npm run build

# ─── runtime ─────────────────────────────────────────────────────────
FROM node:22-alpine AS runtime
# Build provenance — the operator console's Health section shows which commit
# this image came from. Passed by docker-build.yml (--build-arg GIT_SHA=…).
ARG GIT_SHA=""
ENV COBBLR_BUILD_SHA=$GIT_SHA

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
