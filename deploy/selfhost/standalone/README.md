# Standalone self-host stack (image-based)

The two-file install: this `docker-compose.yml` + a `.env` (copy
`.env.example`). No clone, no build — images come from GHCR, multi-arch
(amd64 + arm64, so a Raspberry Pi runs the same file).

This is the recommended way to run Cobblr. If you would rather build the images
yourself, [SELF_HOSTING.md](../../../SELF_HOSTING.md) one level up has that path.

## Install

```bash
mkdir cobblr && cd cobblr
# fetch the two files (from this repo's deploy/selfhost/standalone/)
curl -fsSLO https://raw.githubusercontent.com/CobblrHQ/cobblr/main/deploy/selfhost/standalone/docker-compose.yml
curl -fsSL  https://raw.githubusercontent.com/CobblrHQ/cobblr/main/deploy/selfhost/standalone/.env.example -o .env
# edit .env: set the required secrets (each has a generation command inline)
# and your COBBLR_SITE_ADDRESS + TLS mode
docker compose up -d
```

First boot migrates the database and creates the admin invite flow; open your
site address and follow the signup. HTTPS ships in the box: the `caddy`
profile (`COMPOSE_PROFILES=caddy`, the default) runs the bundled TLS proxy
with four modes — `duckdns` | `cloudflare` | `internal` | `tsnet`
(`COBBLR_TLS_MODE`). Set `COMPOSE_PROFILES=` empty to run bare behind your own
proxy or `tailscale serve/funnel`. The web container binds to loopback always.

## Update

```bash
docker compose pull && docker compose up -d
```

That is the whole update story, **including across PostgreSQL major
versions** — the db image upgrades its own data directory in place, leaving
the old cluster beside it as the rollback. Pick your lane with
`COBBLR_VERSION` in `.env`: `stable` (default via `latest`) | `nightly` |
a pinned `2026.8.0` | a frozen `nightly-YYYY-MM-DD` snapshot.

**Updates are a one-way door**: migrations are forward-only, so moving DOWN a
lane (nightly → stable) can meet a database the older image does not
understand. Keep backups if you ride nightly; rolling back means restoring one.

## Backup

Everything lives in bind mounts under `${COBBLR_DATA_ROOT:-./data}/` — the
database, uploaded files, runtime-installed modules, TLS certs. Copying that
tree while the stack is stopped is a complete backup. For a live database
dump:

```bash
docker compose exec db sh -c 'pg_dumpall -U "$POSTGRES_USER"' | gzip > cobblr-$(date +%F).sql.gz
```

Set `COBBLR_DATA_ROOT` in `.env` to relocate every mount at once (a NAS, a

## Backups

A nightly `pg_dumpall` lands in `${COBBLR_DATA_ROOT}/backups/daily` (Sundays are also
copied to `weekly/`), kept for 30 days and 12 weeks. **Copying the data tree is not a
substitute:** a Postgres data directory copied while the server is running is a torn
snapshot that may not restore. The dumps restore anywhere.

A dump only counts as usable above `BACKUP_MIN_BYTES`, and retention counts only usable
dumps — otherwise a bad week silently evicts the good backups underneath it. A truncated
dump is kept for triage and pruned on its own shorter clock.

Restore one:

```bash
gunzip -c data/backups/daily/cobblr-<stamp>.sql.gz | docker compose exec -T db psql -U cobblr
```

**These dumps live on the same disk as the database.** Copy them somewhere else — that
is the part this stack cannot do for you.

data disk). Deliberately no named volumes.

## Troubleshooting

- **`db` restarts on first boot** — check `docker compose logs db`; a
  `[db-auto-upgrade]` line means it found an older cluster and is upgrading it
  in place (minutes, once).
- **Camera/scanner refuses** — the app requires HTTPS for camera access; see
  the TLS modes above (the `internal` mode works fully offline).
- **Where did my uploads go after an update?** They didn't: files persist
  under `./data/files` because `COBBLR_FILES_ROOT` points there.
  `scripts/lint-selfhost-mounts.ts` (CI) asserts every api mount targets an
  env-var-backed path, after an earlier revision of this file got that wrong.
  If you ran that early revision: salvage with
  `docker compose cp api:/app/_files ./data/files-recovered` and
  `docker compose cp api:/var/cobblr/sandboxed-modules ./data/modules-recovered`,
  then merge into `./data/files` / `./data/modules`.
- **What version am I running?** `curl -s localhost:8088/api/v1/healthz` —
  `version` is your `COBBLR_VERSION` lane, `build_sha` the exact build.

Full guide (TLS walkthroughs, privacy/outbound table, per-provider scan
config, air-gap): [SELF_HOSTING.md](../../../SELF_HOSTING.md).
