# Caddy for the self-hosted stack, built with the DNS-challenge plugins a
# LAN box needs to get a REAL (publicly-trusted) TLS cert.
#
# Why a custom build: the stock `caddy` image can only do the ACME HTTP-01
# challenge, which needs an inbound port 80 reachable from the public internet
# — exactly what a home LAN box does NOT have. The DNS-01 challenge proves
# domain control by writing a TXT record instead, so it works from behind NAT
# with no ports forwarded. Those DNS providers ship as separate Caddy modules
# that have to be compiled in.
#
# Bundled providers (both free):
#   - duckdns    → a free *.duckdns.org subdomain; no domain purchase needed.
#   - cloudflare → your own domain on Cloudflare's free DNS.
# Add more with another `--with github.com/caddy-dns/<provider>` line.
#
# caddy-tailscale (tsnet) is compiled in too: COBBLR_TLS_MODE=tsnet makes the
# proxy join the user's tailnet as its own virtual node and serve
# https://<name>.<tailnet>.ts.net — a real cert, nothing exposed, and no
# Tailscale install on the box (only an auth key).
FROM caddy:2-builder AS builder
RUN xcaddy build \
    --with github.com/caddy-dns/duckdns \
    --with github.com/caddy-dns/cloudflare \
    --with github.com/tailscale/caddy-tailscale

FROM caddy:2-alpine
COPY --from=builder /usr/bin/caddy /usr/bin/caddy

# The four TLS variants ride IN the image so the standalone (image-based)
# stack needs no bind-mounted Caddyfile: pick one with COBBLR_TLS_MODE
# (duckdns | cloudflare | internal | tsnet). A bind-mounted /etc/caddy/Caddyfile
# still wins when present — the clone-and-build overlay keeps working
# unchanged, and it stays the escape hatch for a custom config.
COPY deploy/selfhost/Caddyfile            /etc/caddy/variants/duckdns
COPY deploy/selfhost/Caddyfile.cloudflare /etc/caddy/variants/cloudflare
COPY deploy/selfhost/Caddyfile.internal   /etc/caddy/variants/internal
COPY deploy/selfhost/Caddyfile.tsnet      /etc/caddy/variants/tsnet
COPY docker/caddy-entrypoint.sh /usr/local/bin/caddy-entrypoint.sh
# Drop the base image's stock /etc/caddy/Caddyfile so its presence genuinely
# means "a user bind-mounted one" — otherwise it shadows COBBLR_TLS_MODE.
RUN chmod +x /usr/local/bin/caddy-entrypoint.sh && rm -f /etc/caddy/Caddyfile
ENTRYPOINT ["/usr/local/bin/caddy-entrypoint.sh"]
