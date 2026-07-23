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
  # (cobblr.tail1234.ts.net -> "cobblr"). Two ways to join the tailnet:
  #   * TS_AUTHKEY set   -> headless, non-interactive (mint a reusable key first).
  #   * TS_AUTHKEY empty  -> INTERACTIVE: tsnet asks Tailscale to authorize this
  #     node and logs a one-time approval link. No key to mint; click, sign in,
  #     approve. This is the easier path and now the default when no key is given
  #     (it used to `exit 1` here). Empty-key never worked before, so this only
  #     adds a path -- an existing key-based install is unchanged.
  if [ "$MODE" = "tsnet" ]; then
    export COBBLR_TSNET_NAME="${COBBLR_TSNET_NAME:-${COBBLR_SITE_ADDRESS%%.*}}"
    if [ -z "${TS_AUTHKEY:-}" ]; then
      # tsnet emits the approval link to THESE logs a moment after Caddy starts
      # below (a line like "To authenticate, visit: https://..."). Capturing it
      # to a file would mean wrapping Caddy in a pipe, which breaks its clean
      # shutdown -- that friendlier surfacing is a separate, backlogged change.
      # For now, point the user at the exact one command.
      cat >&2 <<BANNER

============================================================================
  CONNECT THIS BOX TO YOUR TAILSCALE ACCOUNT
----------------------------------------------------------------------------
  No TS_AUTHKEY was set, so Cobblr is asking Tailscale to authorize this box
  interactively. A one-time approval link appears in the log lines just below
  (look for "To authenticate, visit"). Open it, sign in, and approve the node
  named '${COBBLR_TSNET_NAME}'.

  Running detached (docker compose up -d)? Fetch the link any time with:
      docker compose logs caddy | grep -iE 'to authenticate|login.tailscale'

  Once approved, open:  https://${COBBLR_SITE_ADDRESS}

  Prefer not to wait on a link? Set TS_AUTHKEY in .env instead (a reusable key
  from the Tailscale admin console) and restart; that path is fully headless.
============================================================================

BANNER
    else
      echo "caddy-entrypoint: tsnet node '$COBBLR_TSNET_NAME' for $COBBLR_SITE_ADDRESS (auth key)"
    fi
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
