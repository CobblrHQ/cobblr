#!/bin/sh
# Pick the Caddyfile: a bind-mounted /etc/caddy/Caddyfile wins (the
# clone-and-build overlay and any custom config); otherwise use the baked
# variant named by COBBLR_TLS_MODE (duckdns | cloudflare | internal).
set -e
CONFIG=/etc/caddy/Caddyfile
if [ ! -f "$CONFIG" ]; then
  MODE="${COBBLR_TLS_MODE:-duckdns}"
  case "$MODE" in
    duckdns|cloudflare|internal) CONFIG="/etc/caddy/variants/$MODE" ;;
    *) echo "caddy-entrypoint: unknown COBBLR_TLS_MODE '$MODE' (want duckdns|cloudflare|internal)" >&2; exit 1 ;;
  esac
  echo "caddy-entrypoint: using baked variant '$MODE'"
else
  echo "caddy-entrypoint: using bind-mounted /etc/caddy/Caddyfile"
fi
exec caddy run --config "$CONFIG" --adapter caddyfile
