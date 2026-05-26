# Multi-stage Dockerfile for the cobblr-web service. Vite build →
# nginx serves the static SPA + proxies /api to the api container.

# ─── builder ─────────────────────────────────────────────────────────
FROM node:22-alpine AS builder

WORKDIR /app

COPY package.json package-lock.json* tsconfig.base.json ./
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

RUN npm install --workspaces --include-workspace-root --no-audit --no-fund

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
COPY web ./web

WORKDIR /app/web
RUN npm run build

# Sandboxed module UIs. Each module that ships a `ui/` dir gets
# its assets served at /sandboxed/<name>/ alongside the main SPA.
# The parent SPA renders them via iframe — see
# docs/design-decisions/module-isolation.md §6.
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
