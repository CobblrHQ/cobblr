#!/bin/bash
# Bring this instance's data directory up to the image's Postgres major, then
# hand off to the stock entrypoint.
#
# WHY THIS EXISTS: a major Postgres bump was the one update an instance could
# not take by itself. The server refuses to start on an older data dir, so
# somebody had to stop the stack, dump, wipe, restore. That breaks the platform
# rule that updates self-heal (CLAUDE.md §8.1) and it breaks worst for
# SELF-HOSTED instances, where there is no operator with a runbook — a routine
# `docker compose pull` would leave them with a database that will not start.
#
# So the image carries the previous major's binaries too and runs pg_upgrade on
# boot. Pulling a new image is all an instance ever has to do.
#
# THE CONTRACT (in order of preference):
#   1. Upgrade automatically when it is safe to.
#   2. If it is NOT safe (pre-flight fails, pg_upgrade fails, or the operator
#      set COBBLR_DB_MAJOR_UPGRADE=hold), DO NOT die: keep serving the OLD
#      major from the untouched old cluster — the binaries are already in the
#      image — and signal held-back status (a marker file + a row in the
#      `postgres` maintenance DB that the API turns into an admin alert).
#      The upgrade retries on the next container start once the cause is fixed.
#   3. Refuse to start ONLY when serving is impossible (a cluster whose
#      binaries this image does not carry, or a cluster that will not start).
#   An unattended `docker compose pull` (or watchtower) must never leave an
#   instance with a database that will not start.
#
# MOUNT LAYOUTS it accepts, detected per boot (no state file needed):
#   - 18+ layout: the volume is mounted at /var/lib/postgresql; clusters live
#     at <mount>/data (pre-18 position) or <mount>/<major>/docker.
#   - LEGACY layout: the volume is mounted at /var/lib/postgresql/data with the
#     cluster files directly at its root (every pre-18 compose file, and every
#     recreate that carried the old image's PGDATA env — watchtower does this).
#     The mount itself is then the ONLY persistent directory, so everything —
#     old cluster, new cluster, markers — must live INSIDE it: the old cluster
#     is moved (same-filesystem renames, crash-safe via a sentinel) into
#     <mount>/pg<major> and PGDATA is overridden to <mount>/pg<new-major>.
#     Without this, the old code upgraded onto the CONTAINER filesystem —
#     every recreate silently re-upgraded from the stale old cluster and
#     writes since were lost.
#   The stock 18+ entrypoint only rejects old-location data when PGDATA is the
#   default path AND empty; we always hand it a populated, explicit PGDATA, so
#   its guard never fires.
#
# Properties that matter more than speed:
#   - The OLD cluster is left intact. pg_upgrade --link would be faster but
#     leaves the old cluster unusable if anything goes wrong; a copy keeps the
#     rollback, and on a database that fits on one disk that trade is obvious.
#   - Idempotent: a matching or empty data dir is a no-op.
#
# Privilege drops use `gosu` (argv, verbatim), never `su -c` (a shell string).
# The first version built pg_ctl options inside a nested `su postgres -c "…"`
# and they were mangled in the nesting, so pg_ctl failed instantly and the
# upgrade aborted on a cluster that was perfectly healthy.
set -e

NEW_MAJOR="$(postgres --version | sed -E 's/.* ([0-9]+)(\.[0-9]+)?.*/\1/')"
SERVER_ARGS=("$@")

log() { echo "[db-auto-upgrade] $*"; }

# busybox `mountpoint` misses bind mounts (it compares dev/ino, and almost all
# Docker volume mounts are bind mounts), so fall back to /proc/self/mountinfo —
# the same idiom the stock entrypoint uses.
is_mounted() {
  mountpoint -q "$1" 2>/dev/null && return 0
  awk -v p="$1" '$5 == p { found = 1 } END { exit !found }' /proc/self/mountinfo
}

# ── Resolve the persistent root and the target data dir ─────────────────────
LEGACY_MNT=/var/lib/postgresql/data
LEGACY=0
# The decisive fact is the OLD DATA PATH being a mountpoint: that only happens
# when the operator (or a recreate preserving their binds) mounted it, and then
# it is the only persistent directory there is. Do NOT condition on the parent:
# this image declares VOLUME /var/lib/postgresql, so with only the data path
# bind-mounted, dockerd auto-creates a THROWAWAY anonymous volume at the parent
# — it reads as mounted, and an upgrade sent there vanishes on the next
# recreate. (Found by the smoke matrix: the exact watchtower-recreate shape.)
if is_mounted "$LEGACY_MNT"; then
  LEGACY=1
  ROOT="$LEGACY_MNT"
  if [ -s "$ROOT/PG_VERSION" ] && [ "$(cat "$ROOT/PG_VERSION")" = "$NEW_MAJOR" ]; then
    # A current-major cluster already lives at the mount root (an instance that
    # upgraded under an explicit old-style PGDATA). Serve it where it is;
    # restructuring a healthy cluster is risk with no payoff. The next major
    # bump migrates it into the pg<major> layout.
    export PGDATA="$ROOT"
  else
    export PGDATA="$ROOT/pg$NEW_MAJOR"
  fi
  log "legacy mount detected at $LEGACY_MNT — clusters live inside it; PGDATA=$PGDATA"
elif [ "${PGDATA:-}" = "$LEGACY_MNT" ]; then
  # Stale env carried onto the new layout (mount at /var/lib/postgresql):
  # PGDATA points at the old position inside the new mount.
  ROOT=/var/lib/postgresql
  if [ -s "$LEGACY_MNT/PG_VERSION" ] && [ "$(cat "$LEGACY_MNT/PG_VERSION")" = "$NEW_MAJOR" ]; then
    # A current-major cluster already lives there (inside the mount, so it is
    # persistent) — serve it where it is rather than orphaning it.
    :
  else
    export PGDATA="/var/lib/postgresql/$NEW_MAJOR/docker"
    log "ignoring carried-over PGDATA=$LEGACY_MNT on the 18+ mount layout; PGDATA=$PGDATA"
  fi
else
  : "${PGDATA:?PGDATA must be set}"
  # PGDATA is /var/lib/postgresql/<major>/docker, so the mount root is two up.
  ROOT="$(dirname "$(dirname "$PGDATA")")"
fi
NEW_DATA="$PGDATA"
SENTINEL="$ROOT/.cobblr-migrating"
HOLD_MARKER="$ROOT/.cobblr-db-held-back"

# ── Held-back signalling ─────────────────────────────────────────────────────
# A marker file next to the data (cheap boot-time check) plus a row in the
# `postgres` maintenance database, which the API reads and turns into an admin
# alert. The row is written/cleared in the background once the server accepts
# connections — as the local OS user, trying the declared superuser first
# (a cluster created with POSTGRES_USER has no `postgres` role).
signal_status_row() {
  local mode="$1" reason="$2" old_major="$3" detail="$4"
  (
    local tries=0 u
    until gosu postgres pg_isready -q -d postgres >/dev/null 2>&1; do
      tries=$((tries + 1)); [ "$tries" -gt 60 ] && exit 0
      sleep 3
    done
    for u in "${POSTGRES_USER:-}" postgres; do
      [ -n "$u" ] || continue
      if [ "$mode" = held ]; then
        gosu postgres psql -U "$u" -d postgres -v ON_ERROR_STOP=1 -q \
          -c "create table if not exists cobblr_db_status (
                key text primary key,
                held boolean not null,
                reason text,
                detail text,
                old_major int,
                target_major int,
                since timestamptz not null default now(),
                updated_at timestamptz not null default now())" \
          -c "insert into cobblr_db_status (key, held, reason, detail, old_major, target_major)
              values ('major_upgrade', true, '$reason', \$cobblr\$${detail}\$cobblr\$, $old_major, $NEW_MAJOR)
              on conflict (key) do update
                set held = true, reason = excluded.reason, detail = excluded.detail,
                    old_major = excluded.old_major, target_major = excluded.target_major,
                    updated_at = now()" \
          >/dev/null 2>&1 && break
      else
        gosu postgres psql -U "$u" -d postgres -q \
          -c "delete from cobblr_db_status where key = 'major_upgrade'" \
          >/dev/null 2>&1 && break
      fi
    done
  ) &
}

# Serve the OLD major from the untouched old cluster instead of dying. This is
# deliberately a minimal stand-in for the stock entrypoint: the cluster already
# exists (no initdb concerns), created by this same image family (same uid, same
# libc, same collation), so ownership + exec is all that is needed.
hold_back_serve_old() {
  local old_data="$1" old_major="$2" reason="$3" detail="$4"
  local old_bin="/usr/libexec/postgresql${old_major}"
  if [ ! -x "$old_bin/postgres" ]; then
    log "FATAL: cannot hold back on Postgres $old_major — this image carries no"
    log "binaries for it. Refusing to start rather than guess."
    exit 1
  fi
  log "=================================================================================="
  log "MAJOR UPGRADE HELD BACK (${reason}): ${detail}"
  log "Serving PostgreSQL ${old_major} from the UNTOUCHED existing cluster instead of"
  log "failing to start. Nothing was modified. The upgrade to ${NEW_MAJOR} retries on the"
  log "next container start once the cause is resolved."
  log "See docs/operations/PRODUCTION_DEPLOY.md (major Postgres upgrades)."
  log "=================================================================================="
  printf 'reason=%s\nold_major=%s\ntarget_major=%s\ndetail=%s\n' \
    "$reason" "$old_major" "$NEW_MAJOR" "$detail" > "$HOLD_MARKER"
  chown postgres:postgres "$HOLD_MARKER" 2>/dev/null || true
  signal_status_row held "$reason" "$old_major" "$detail"
  # Serving needs the postgres user to traverse the mount root and own the
  # cluster dir — same root-side normalization the stock entrypoint performs.
  chown postgres:postgres "$ROOT" 2>/dev/null || true
  chown postgres:postgres "$old_data" 2>/dev/null || true
  chmod 0700 "$old_data" 2>/dev/null || true
  set -- "${SERVER_ARGS[@]}"
  [ "${1:-}" = postgres ] && shift
  exec gosu postgres "$old_bin/postgres" -D "$old_data" "$@"
}

# ── Legacy-root migration (crash-safe, same-filesystem renames) ──────────────
# Moves a cluster living directly at $ROOT into $ROOT/pg<major>. The sentinel
# is written first and removed last, so a crash mid-move resumes on next boot:
# already-moved entries are simply no longer at the root.
migrate_legacy_root() {
  local old_major="$1" dest="$ROOT/pg$1" entry base
  echo "pg$old_major" > "$SENTINEL"
  mkdir -p "$dest"
  chown postgres:postgres "$dest"
  chmod 0700 "$dest"
  for entry in "$ROOT"/* "$ROOT"/.[!.]* "$ROOT"/..?*; do
    [ -e "$entry" ] || [ -L "$entry" ] || continue
    base="$(basename "$entry")"
    case "$base" in
      pg[0-9]*| .cobblr-* | lost+found) continue ;;
    esac
    mv "$entry" "$dest/"
  done
  rm -f "$SENTINEL"
  log "moved the Postgres $old_major cluster into $dest (same mount, rename only)"
}

if [ "$LEGACY" = 1 ]; then
  if [ -s "$SENTINEL" ]; then
    resume_dest="$(cat "$SENTINEL")"
    log "resuming an interrupted cluster move into $resume_dest"
    migrate_legacy_root "${resume_dest#pg}"
  fi
  if [ -s "$ROOT/PG_VERSION" ] && [ "$(cat "$ROOT/PG_VERSION")" != "$NEW_MAJOR" ]; then
    migrate_legacy_root "$(cat "$ROOT/PG_VERSION")"
  fi
fi

# Where an older cluster might be: the pre-18 docker layout put it directly at
# <root>/data; 18+ uses <root>/<major>/docker; the legacy-mount layout uses
# <root>/pg<major>.
find_old_cluster() {
  local candidate v
  for candidate in "$ROOT/data" "$ROOT"/*/docker "$ROOT"/pg[0-9]*; do
    [ "$candidate" = "$NEW_DATA" ] && continue
    [ -s "$candidate/PG_VERSION" ] || continue
    v="$(cat "$candidate/PG_VERSION")"
    if [ "$v" -lt "$NEW_MAJOR" ] 2>/dev/null; then
      echo "$candidate"
      return 0
    fi
  done
  return 1
}

# The old cluster's superuser, encoding and locale are NOT in pg_control — the
# encoding and collation live in pg_database and the bootstrap superuser in
# pg_authid, so both need a running server. Start the old one privately (unix
# socket in a temp dir, no TCP) and ask it. Guessing instead is how this fails:
# initdb'ing with the wrong encoding makes pg_upgrade refuse, and hardcoding
# "postgres" is wrong on every instance that set POSTGRES_USER.
probe_old_cluster() {
  local old_data="$1" old_bin="$2" sock row
  sock="$(mktemp -d /tmp/oldpg.XXXXXX)"
  chown postgres:postgres "$sock"
  # -t is generous: a large cluster needing crash recovery can take minutes,
  # and a short timeout would abort an upgrade that was merely slow.
  if ! gosu postgres "$old_bin/pg_ctl" -D "$old_data" -w -t 900 \
        -o "-c listen_addresses= -c unix_socket_directories=$sock" \
        start >/tmp/db-oldstart.log 2>&1; then
    log "could not start the Postgres $(cat "$old_data/PG_VERSION") cluster to read its settings:"
    tail -15 /tmp/db-oldstart.log
    return 1
  fi
  # psql defaults to the OS user (postgres), and that role does not exist on a
  # cluster created with POSTGRES_USER set — the first run failed here with
  # `role "postgres" does not exist` on a cluster whose superuser is `cobblr`.
  # Try the env-declared user first, then the stock default; ANY superuser
  # connection is enough to then ask for the real bootstrap role (oid 10).
  local conn_user=""
  for candidate in "${POSTGRES_USER:-}" postgres; do
    [ -n "$candidate" ] || continue
    if gosu postgres "$old_bin/psql" -h "$sock" -U "$candidate" -d postgres -tAc "select 1" \
         >/dev/null 2>&1; then
      conn_user="$candidate"
      break
    fi
  done
  if [ -z "$conn_user" ]; then
    log "could not connect to the old cluster as ${POSTGRES_USER:-<unset>} or postgres."
    gosu postgres "$old_bin/pg_ctl" -D "$old_data" -w -t 900 stop >>/tmp/db-oldstart.log 2>&1 || true
    rm -rf "$sock"
    return 1
  fi
  OLD_SUPERUSER="$(gosu postgres "$old_bin/psql" -h "$sock" -U "$conn_user" -d postgres -tAc \
      "select rolname from pg_authid where oid = 10" 2>/dev/null | tr -d ' ')"
  row="$(gosu postgres "$old_bin/psql" -h "$sock" -U "$conn_user" -d postgres -tAc \
      "select pg_encoding_to_char(encoding)||'|'||datcollate||'|'||datctype from pg_database where datname='template0'" 2>/dev/null)"
  OLD_ENCODING="${row%%|*}"
  row="${row#*|}"
  OLD_COLLATE="${row%%|*}"
  OLD_CTYPE="${row#*|}"
  # A clean shutdown is not tidying up: pg_upgrade REFUSES a cluster that was
  # not shut down cleanly, so this stop is part of the upgrade.
  gosu postgres "$old_bin/pg_ctl" -D "$old_data" -w -t 900 stop >>/tmp/db-oldstart.log 2>&1 || true
  rm -rf "$sock"
  [ -n "$OLD_SUPERUSER" ] && [ -n "$OLD_ENCODING" ]
}

upgrade_from() {
  local old_data="$1"
  local old_major old_bin
  old_major="$(cat "$old_data/PG_VERSION")"
  old_bin="/usr/libexec/postgresql${old_major}"

  if [ ! -x "$old_bin/pg_ctl" ]; then
    log "FATAL: found a Postgres $old_major cluster at $old_data, but this image"
    log "carries no Postgres $old_major binaries, so it cannot upgrade it."
    log "Refusing to start rather than leave the data in an unknown state."
    log "Run the previous image version, or restore from a dump."
    exit 1
  fi

  # ── Pre-flight: every failure routes to held-back serving, never a dead DB ──
  if [ "${COBBLR_DB_MAJOR_UPGRADE:-auto}" = hold ]; then
    hold_back_serve_old "$old_data" "$old_major" operator_hold \
      "COBBLR_DB_MAJOR_UPGRADE=hold is set; set it to auto (or unset it) and restart to upgrade"
  fi
  # pg_upgrade copies the cluster (the old one stays as the rollback), so the
  # mount needs roughly the old cluster's size free, plus margin.
  local old_kb avail_kb need_kb
  old_kb="$(du -sk "$old_data" 2>/dev/null | awk '{print $1}')"
  avail_kb="$(df -Pk "$ROOT" 2>/dev/null | awk 'NR==2 {print $4}')"
  if [ -n "$old_kb" ] && [ -n "$avail_kb" ]; then
    need_kb=$(( old_kb + old_kb / 5 + 262144 ))
    if [ "$avail_kb" -lt "$need_kb" ]; then
      hold_back_serve_old "$old_data" "$old_major" insufficient_disk \
        "upgrading needs ~$((need_kb / 1024))MB free on the data volume, only $((avail_kb / 1024))MB available; free space and restart"
    fi
  fi
  # A fresh bind-mount root arrives root-owned — that is normal, not an operator
  # error: the stock entrypoint fixes ownership as root before postgres ever
  # runs. Mirror that (non-recursive; the volume is dedicated to postgres)
  # BEFORE judging writability as the postgres user, or every first boot on a
  # fresh mount false-holds.
  chown postgres:postgres "$ROOT" 2>/dev/null || true
  if ! gosu postgres touch "$ROOT/.cobblr-writetest" 2>/dev/null; then
    hold_back_serve_old "$old_data" "$old_major" unwritable_volume \
      "the data volume is not writable by the postgres user; fix the mount and restart"
  fi
  rm -f "$ROOT/.cobblr-writetest"

  if ! probe_old_cluster "$old_data" "$old_bin"; then
    hold_back_serve_old "$old_data" "$old_major" probe_failed \
      "could not read the old cluster's superuser/encoding (see container logs); not guessing"
  fi
  log "upgrading Postgres $old_major -> $NEW_MAJOR"
  log "  superuser=$OLD_SUPERUSER encoding=$OLD_ENCODING collate=$OLD_COLLATE ctype=$OLD_CTYPE"

  # Postgres 18 enables data page checksums BY DEFAULT; every cluster created
  # before it has them off, and pg_upgrade refuses to bridge that difference
  # ("old cluster does not use data checksums but the new one does"). Match the
  # old cluster instead of taking the new default — otherwise the self-upgrade
  # fails on every instance that predates 18. Changing the setting is a
  # separate, offline pg_checksums job, deliberately not done here.
  local checksums
  if [ "$("$old_bin/pg_controldata" "$old_data" | sed -n 's/^Data page checksum version: *//p')" = "0" ]; then
    checksums="--no-data-checksums"
  else
    checksums="--data-checksums"
  fi
  log "  data checksums: ${checksums#--}"

  mkdir -p "$NEW_DATA"
  chown postgres:postgres "$NEW_DATA"
  chmod 0700 "$NEW_DATA"

  if ! gosu postgres initdb -D "$NEW_DATA" --username="$OLD_SUPERUSER" \
        --encoding="$OLD_ENCODING" --lc-collate="$OLD_COLLATE" --lc-ctype="$OLD_CTYPE" \
        "$checksums" >/tmp/db-initdb.log 2>&1; then
    log "initdb for the new cluster failed:"
    tail -20 /tmp/db-initdb.log
    rm -rf "${NEW_DATA:?}"
    hold_back_serve_old "$old_data" "$old_major" initdb_failed \
      "initdb for the new cluster failed (see container logs); the old cluster is untouched"
  fi

  # pg_upgrade writes working files to the CWD, which must be writable by
  # postgres — /tmp always is, the data root may not be.
  cd /tmp
  if gosu postgres pg_upgrade \
        --old-datadir="$old_data" --new-datadir="$NEW_DATA" \
        --old-bindir="$old_bin" --new-bindir=/usr/local/bin \
        --username="$OLD_SUPERUSER" >/tmp/db-pg_upgrade.log 2>&1; then
    log "pg_upgrade succeeded; the Postgres $old_major cluster is untouched at"
    log "$old_data — delete it once you are satisfied with the upgrade."
    for f in pg_hba.conf pg_ident.conf postgresql.conf; do
      [ -f "$old_data/$f" ] && cp "$old_data/$f" "$NEW_DATA/$f"
    done
    chown postgres:postgres "$NEW_DATA"/*.conf 2>/dev/null || true
    # pg_upgrade only carries planner statistics from Postgres 18 onward. From
    # anything older the new cluster starts blind, so schedule the ANALYZE.
    # Record WHO to connect as: the ANALYZE below runs on a later boot too,
    # where $OLD_SUPERUSER is long out of scope, and vacuumdb defaults to the
    # OS user (postgres) — a role that does not exist on a cluster created with
    # POSTGRES_USER set. Same bug as the probe, one boot later.
    echo "$OLD_SUPERUSER" > "$NEW_DATA/.needs-analyze"
    chown postgres:postgres "$NEW_DATA/.needs-analyze"
  else
    log "pg_upgrade FAILED. The old cluster is untouched. Last lines:"
    tail -25 /tmp/db-pg_upgrade.log
    rm -rf "${NEW_DATA:?}"
    hold_back_serve_old "$old_data" "$old_major" pg_upgrade_failed \
      "pg_upgrade failed (see container logs); the old cluster is untouched"
  fi
}

if [ ! -s "$NEW_DATA/PG_VERSION" ]; then
  if old_cluster="$(find_old_cluster)"; then
    upgrade_from "$old_cluster"
  fi
fi

if [ -f "$NEW_DATA/.needs-analyze" ]; then
  # Backgrounded: the server has to be accepting connections first, and a cold
  # database is better than a delayed one.
  (
    analyze_user=""
    sleep 25
    analyze_user="$(head -1 "$NEW_DATA/.needs-analyze" 2>/dev/null | tr -d ' ')"
    [ -n "$analyze_user" ] || analyze_user="${POSTGRES_USER:-postgres}"
    if gosu postgres vacuumdb -U "$analyze_user" --all --analyze-only -j 2 \
         >/tmp/db-analyze.log 2>&1; then
      rm -f "$NEW_DATA/.needs-analyze"
      log "post-upgrade ANALYZE complete"
    else
      log "post-upgrade ANALYZE failed (queries still work, plans may be poor):"
      tail -5 /tmp/db-analyze.log
    fi
  ) &
fi

# A successful boot on the target major clears any held-back signal from an
# earlier boot, so the admin alert shuts itself off.
if [ -f "$HOLD_MARKER" ] && [ -s "$NEW_DATA/PG_VERSION" ] \
     && [ "$(cat "$NEW_DATA/PG_VERSION")" = "$NEW_MAJOR" ]; then
  rm -f "$HOLD_MARKER"
  signal_status_row clear "" 0 ""
  log "held-back state resolved — now on Postgres $NEW_MAJOR"
fi

exec docker-entrypoint.sh "${SERVER_ARGS[@]}"
