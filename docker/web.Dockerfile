# Multi-stage Dockerfile for the cobblr-web service. Vite build →
# nginx serves the static SPA + proxies /api to the api container.

# ─── builder ─────────────────────────────────────────────────────────
FROM node:22-alpine AS builder

WORKDIR /app

COPY package.json package-lock.json* tsconfig.base.json ./
COPY web/package.json ./web/
COPY api/package.json ./api/
COPY packages/platform-contract/package.json ./packages/platform-contract/

RUN npm install --workspaces --include-workspace-root --no-audit --no-fund

COPY packages/platform-contract ./packages/platform-contract
COPY web ./web

WORKDIR /app/web
RUN npm run build

# ─── runtime ─────────────────────────────────────────────────────────
FROM nginx:1.27-alpine AS runtime

COPY --from=builder /app/web/dist /usr/share/nginx/html
COPY docker/nginx.conf /etc/nginx/conf.d/default.conf

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://127.0.0.1:8080/ || exit 1
