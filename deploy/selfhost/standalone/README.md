# Standalone self-host stack (image-based)

The two-file install: `docker-compose.yml` + `.env` (copy `.env.example`).
No clone, no build — images come from GHCR, multi-arch (amd64 + arm64, so a
Pi runs the same file). INERT until the public images publish; until then the
clone-and-build overlay one directory up is the supported path.

Design + rationale: the selfhost compose spec (internal _tmp). Highlights:
one file, HTTPS via the `caddy` profile (`COMPOSE_PROFILES=` empty for
tailscale serve/funnel), TLS variants baked into the caddy image
(`COBBLR_TLS_MODE`), web bound to loopback always, bind mounts only under
`./data/` (copying that tree is a complete backup).
