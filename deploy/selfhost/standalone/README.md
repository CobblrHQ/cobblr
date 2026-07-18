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

**Mount + env lockstep (data-loss guard).** Uploaded files and runtime-installed
modules only persist because `COBBLR_FILES_ROOT` / `COBBLR_RUNTIME_MODULES_DIR`
point the app at the `./data/*` bind mounts. An earlier revision of this file
mounted `/files` and `/app/installed-modules` — paths the app never writes — so
every `docker compose pull && up -d` discarded uploads and installed modules
from the container's writable layer. If you ran that revision, salvage before
updating: `docker compose cp api:/app/_files ./data/files-recovered` (uploads)
and `docker compose cp api:/var/cobblr/sandboxed-modules ./data/modules-recovered`,
then merge those into `./data/files` / `./data/modules`.
`scripts/lint-selfhost-mounts.ts` (CI) now asserts every api mount targets an
env-var-backed path so this class can't return.
