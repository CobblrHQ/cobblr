# syntax=docker/dockerfile:1
# Multi-stage Dockerfile for the cobblr-web service. Vite build →
# nginx serves the static SPA + proxies /api to the api container.
# BuildKit (enabled in CI) makes the pnpm-store cache mount below persists pnpm's
# download cache across builds.

# ─── builder ─────────────────────────────────────────────────────────
FROM node:22-alpine AS builder
# Accepted for parity with api.Dockerfile (docker-build.yml passes it to both
# matrix legs); the web image doesn't use it.
ARG GIT_SHA=""

WORKDIR /app

# The workspace install pulls in api's native bcrypt. node-pre-gyp normally
# fetches a musl prebuilt, but a transient registry/CDN miss falls back to a
# source build — which needs a toolchain. Without this the web image build dies
# on "gyp ERR! find Python" whenever the prebuilt fetch hiccups.
RUN apk add --no-cache python3 make g++

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY web/package.json ./web/
COPY api/package.json ./api/
COPY packages/platform-contract/package.json ./packages/platform-contract/
COPY packages/platform-web/package.json ./packages/platform-web/
COPY modules/inventory/package.json ./modules/inventory/
COPY modules/labels/package.json ./modules/labels/
COPY modules/projects/package.json ./modules/projects/
COPY modules/purchases/package.json ./modules/purchases/
COPY modules/machines/package.json ./modules/machines/
COPY modules/assets/package.json ./modules/assets/
COPY modules/records/package.json ./modules/records/
COPY modules/lists/package.json ./modules/lists/
COPY modules/builds/package.json ./modules/builds/
COPY modules/sales/package.json ./modules/sales/
COPY modules/tracking/package.json ./modules/tracking/
COPY modules/core-file-preview/package.json ./modules/core-file-preview/
COPY modules/knowledge/package.json ./modules/knowledge/

RUN corepack enable
RUN --mount=type=cache,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile

COPY packages/platform-contract ./packages/platform-contract
COPY packages/platform-web ./packages/platform-web
# Module UI sources — Vite resolves @cobblr/<name>/ui to the TSX
# source at build time. Each new module gets a line here.
COPY modules/inventory ./modules/inventory
COPY modules/labels ./modules/labels
COPY modules/projects ./modules/projects
COPY modules/purchases ./modules/purchases
COPY modules/machines ./modules/machines
COPY modules/assets ./modules/assets
COPY modules/records ./modules/records
COPY modules/lists ./modules/lists
COPY modules/builds ./modules/builds
COPY modules/sales ./modules/sales
COPY modules/tracking ./modules/tracking
COPY modules/core-file-preview ./modules/core-file-preview
COPY modules/knowledge ./modules/knowledge
COPY web ./web

# Build web from the workspace ROOT via --filter (NOT `pnpm run build` from inside
# /app/web, which re-installs/re-downloads the whole store). Just runs the build.
RUN pnpm --filter @cobblr/web run build

# Sandboxed module UIs. Each module that ships a `ui/` dir gets
# its assets served at /sandboxed/<name>/ alongside the main SPA.
# The parent SPA renders them via iframe — see
# docs/architecture/module-isolation.md §6.
COPY sandboxed-modules /tmp/sandboxed-modules
RUN mkdir -p /app/web/dist/sandboxed && \
    for d in /tmp/sandboxed-modules/*/ui; do \
      if [ -d "$d" ]; then \
        name=$(basename $(dirname $d)); \
        cp -r "$d" "/app/web/dist/sandboxed/$name"; \
        echo "[web-build] sandboxed UI: $name"; \
      fi; \
    done

# ─── runtime ─────────────────────────────────────────────────────────
FROM nginx:1.27-alpine AS runtime

COPY --from=builder /app/web/dist /usr/share/nginx/html
COPY docker/nginx.conf /etc/nginx/conf.d/default.conf

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://127.0.0.1:8080/ || exit 1
