#!/bin/sh
# Pick the Caddyfile: a bind-mounted /etc/caddy/Caddyfile wins (the
# clone-and-build overlay and any custom config); otherwise use the baked
# variant named by COBBLR_TLS_MODE (duckdns | cloudflare | internal).
set -e
CONFIG=/etc/caddy/Caddyfile
if [ ! -f "$CONFIG" ]; then
  MODE="${COBBLR_TLS_MODE:-duckdns}"
  case "$MODE" in
    duckdns|cloudflare|internal|tsnet) CONFIG="/etc/caddy/variants/$MODE" ;;
    *) echo "caddy-entrypoint: unknown COBBLR_TLS_MODE '$MODE' (want duckdns|cloudflare|internal|tsnet)" >&2; exit 1 ;;
  esac
  echo "caddy-entrypoint: using baked variant '$MODE'"

  # tsnet: the virtual node's name defaults to the address's first label
  # (cobblr.tail1234.ts.net -> "cobblr"). TS_AUTHKEY must be set or the node
  # can't join the tailnet — fail loud here, not as a cryptic tsnet error.
  if [ "$MODE" = "tsnet" ]; then
    export COBBLR_TSNET_NAME="${COBBLR_TSNET_NAME:-${COBBLR_SITE_ADDRESS%%.*}}"
    if [ -z "${TS_AUTHKEY:-}" ]; then
      echo "caddy-entrypoint: COBBLR_TLS_MODE=tsnet needs TS_AUTHKEY (a reusable auth key from the Tailscale admin console)" >&2
      exit 1
    fi
    echo "caddy-entrypoint: tsnet node '$COBBLR_TSNET_NAME' for $COBBLR_SITE_ADDRESS"
  fi

  # The ACME variants carry `email {$COBBLR_ACME_EMAIL}` as an OPTIONAL contact
  # address. When the var is unset/blank it renders as a bare `email`, which is a
  # Caddyfile parse error and crash-loops the container. The field is meant to be
  # optional, so drop the line when there is no value: render the selected
  # variant to a writable copy and run that. Self-heals any .env that never set
  # COBBLR_ACME_EMAIL.
  if [ -z "${COBBLR_ACME_EMAIL:-}" ]; then
    RENDERED=/tmp/Caddyfile.active
    grep -v 'COBBLR_ACME_EMAIL' "$CONFIG" > "$RENDERED"
    CONFIG="$RENDERED"
    echo "caddy-entrypoint: COBBLR_ACME_EMAIL empty; omitting optional ACME email"
  fi
else
  echo "caddy-entrypoint: using bind-mounted /etc/caddy/Caddyfile"
fi
exec caddy run --config "$CONFIG" --adapter caddyfile
