# syntax=docker/dockerfile:1
# Multi-stage Dockerfile for the cobblr-api service. Image is the
# source of truth at runtime — no bind mounts in compose.
# BuildKit is enabled in CI (docker-build.yml) so the pnpm-store cache mount below
# persists pnpm's content-addressable store across builds — installs don't re-fetch tarballs.

# ─── builder ─────────────────────────────────────────────────────────
FROM node:22-alpine AS builder

WORKDIR /app

# Toolchain for native deps (bcrypt): node-pre-gyp fetches a musl prebuilt,
# but a transient fetch miss falls back to a source build that needs Python +
# a C++ compiler. Cheap insurance against "gyp ERR! find Python" build deaths.
RUN apk add --no-cache python3 make g++

# Copy every workspace's package.json before installing so pnpm can
# resolve the symlinks without redoing the install on every source
# change. As new modules land, add their package.json copies here.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
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
COPY modules/core-placement/package.json ./modules/core-placement/
COPY modules/core-locations/package.json ./modules/core-locations/
COPY modules/core-catalogs/package.json ./modules/core-catalogs/
COPY modules/core-import/package.json ./modules/core-import/
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
COPY modules/builds/package.json ./modules/builds/
COPY modules/sales/package.json ./modules/sales/
COPY modules/tracking/package.json ./modules/tracking/
COPY modules/digifab/package.json ./modules/digifab/
COPY modules/core-devices/package.json ./modules/core-devices/
COPY modules/core-mobility/package.json ./modules/core-mobility/
COPY modules/core-file-preview/package.json ./modules/core-file-preview/
COPY modules/bricklink-connector/package.json ./modules/bricklink-connector/
COPY modules/core-print/package.json ./modules/core-print/
COPY modules/knowledge/package.json ./modules/knowledge/
# v0.3 sandbox SDK + AS sample module. Workspace-resolved so the
# AS author repo (sandboxed-modules/hello-as) sees the SDK at build
# time. The api runtime doesn't import these — only the AS toolchain.
COPY packages/sandbox-sdk-as/package.json ./packages/sandbox-sdk-as/
COPY sandboxed-modules/hello-as/package.json ./sandboxed-modules/hello-as/

RUN corepack enable
RUN --mount=type=cache,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile

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
# All module source in one layer. The per-module tsc builds are gone — a single
# esbuild pass (below) transpiles every module + the api in ~seconds, so the
# fine-grained per-module cache layers no longer earn their keep. Registry
# modules (install-registry-modules.mjs) land after this and are built too.
COPY modules ./modules

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
# Served read-only by the public /changelog endpoint (api/src/routes/changelog.ts):
# changelog.d/ is the LIVE archive (one changeset file per change), CHANGELOG.md is
# the frozen pre-cutover history.
COPY CHANGELOG.md ./CHANGELOG.md
COPY changelog.d ./changelog.d
# Build the api + EVERY module in one esbuild transpile-only pass (~seconds vs
# the ~40 sequential `tsc` builds this replaced — those were the dominant cost of
# this image, ~90s). Same dist/*.js layout tsc produced; imports stay external and
# resolve at runtime identically. Safe because: (1) the CI `typecheck` job runs
# real `tsc --noEmit` across the workspace and gates every deploy, so type errors
# never reach here; (2) the CI `test` job builds with this EXACT script (esbuild)
# and runs all 966 integration tests green — so prod runs proven-equivalent code;
# (3) tsconfig sets isolatedModules, so per-file transpile is sound. See
# scripts/fast-build.mjs. (Runs from /app so it discovers modules/* + api.)
RUN node scripts/fast-build.mjs

# ─── runtime ─────────────────────────────────────────────────────────
FROM node:22-alpine AS runtime
# Build provenance — the operator console's Health section shows which commit
# this image came from. Passed by docker-build.yml (--build-arg GIT_SHA=…).
ARG GIT_SHA=""
ENV COBBLR_BUILD_SHA=$GIT_SHA

WORKDIR /app

ENV NODE_ENV=production

# Bring over what we need at runtime: built artifacts + the root node_modules.
# pnpm (nodeLinker: hoisted) hoists EXTERNAL deps here — but NOT the workspace
# packages (@cobblr/*), which it links per-consumer, not at the root. Those are
# re-symlinked further down (search "@cobblr") from the /app/modules + /app/packages
# dirs we also copy; without that the api can't resolve its own workspace imports.
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
# The "What's new" archive, served read-only by GET /api/v1/changelog —
# the live changesets + the frozen history.
COPY --from=builder /app/CHANGELOG.md ./CHANGELOG.md
COPY --from=builder /app/changelog.d ./changelog.d
# Flagship bundle manifests — read at runtime by the capture-first quickstart
# (api/src/lib/flagship-bundles.ts) so onboarding works offline + for every
# self-hoster, independent of the private GitHub registry. Lands at /app/bundles
# (cwd is /app/api at runtime; the loader resolves ../bundles).
COPY bundles ./bundles

# pnpm (nodeLinker: hoisted) hoists EXTERNAL deps into the root node_modules, but
# unlike npm's flat hoist it does NOT place the WORKSPACE packages (@cobblr/*)
# there — so the api's static `import … from "@cobblr/<pkg>"` calls (platform-
# contract, core-scan, every module) don't resolve at runtime and the container
# crash-loops with ERR_MODULE_NOT_FOUND. Recreate those root symlinks from the
# workspace dirs we already ship (/app/modules/* and /app/packages/*), restoring
# npm-equivalent resolution. (CI builds/typechecks against the dev checkout and
# never boots the image, so this gap shipped silently once — the build workflow's
# boot smoke test now guards it.)
RUN mkdir -p /app/node_modules/@cobblr \
 && for d in /app/modules/* /app/packages/*; do \
      [ -f "$d/package.json" ] || continue; \
      n=$(node -p "require('$d/package.json').name" 2>/dev/null) || continue; \
      case "$n" in @cobblr/*) ln -sfn "$d" "/app/node_modules/$n" ;; esac; \
    done

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
