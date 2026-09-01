#!/usr/bin/env sh
# Reports .env values that a RUNNING container never picked up.
#
# Why this exists: an image updater re-creates a container by CLONING the running
# one's configuration, so it carries the old environment forward and never re-reads
# .env. Compose only reads .env when a container is CREATED. So after editing .env
# you can watch fresh containers start on a new image and still be running the old
# values, with nothing anywhere reporting a problem. One box ran for weeks with its
# captcha configured in .env and switched off in the container that way.
#
# `docker compose up -d` is what applies an .env change. A restart is not enough,
# and neither is an automatic update. This tells you when that has been missed.
#
# Only keys the container ALREADY HAS are compared. A key in .env that a container
# was never passed is a different problem (the compose file has to list it), and
# folding the two together would make every run noisy.
#
# Known limit: a value written as ${OTHER} in .env is compared literally, while
# Compose expands it before the container sees it. Such a key reports as drift
# on every run. None of our stacks write .env that way; if yours does, expect it.
#
# Usage:  ./check-env-drift.sh [stack-dir]      (default: the current directory)
# Exit:   0 no drift  ·  1 drift found  ·  2 could not run the check
set -eu

DIR="${1:-.}"
cd "$DIR" || { echo "check-env-drift: no such directory: $DIR" >&2; exit 2; }
[ -f .env ] || { echo "check-env-drift: no .env in $(pwd)" >&2; exit 2; }

# Test seam: with ENV_DRIFT_INSPECT_DIR set, container environments are read from
# <dir>/<container>.env instead of from Docker, so the comparison itself can be
# exercised in CI on a machine with no daemon. Nothing in normal use sets it.
FAKE="${ENV_DRIFT_INSPECT_DIR:-}"

if [ -n "$FAKE" ]; then
  CONTAINERS=$(ls "$FAKE" | sed 's/\.env$//')
else
  command -v docker >/dev/null 2>&1 || { echo "check-env-drift: docker not found" >&2; exit 2; }
  CONTAINERS=$(docker compose ps --format '{{.Name}}' 2>/dev/null || true)
fi
[ -n "$CONTAINERS" ] || { echo "check-env-drift: no running containers for this stack" >&2; exit 2; }

DRIFT=0
CHECKED=0
TMP="${TMPDIR:-/tmp}/env-drift.$$"
trap 'rm -f "$TMP"' EXIT INT TERM

for C in $CONTAINERS; do
  if [ -n "$FAKE" ]; then
    cp "$FAKE/$C.env" "$TMP" 2>/dev/null || continue
  else
    docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' "$C" > "$TMP" 2>/dev/null || continue
  fi

  # Read .env, never `source` it: sourcing runs whatever is in the file, and an
  # unquoted value containing a space or a $ would not survive the round trip.
  while IFS= read -r LINE || [ -n "$LINE" ]; do
    case "$LINE" in ''|'#'*) continue ;; esac
    case "$LINE" in *=*) ;; *) continue ;; esac
    KEY=${LINE%%=*}
    WANT=${LINE#*=}
    case "$KEY" in ''|*[!A-Za-z0-9_]*) continue ;; esac      # not a shell-safe name
    # Compose strips one layer of surrounding quotes; match that.
    case "$WANT" in
      \"*\") WANT=$(printf '%s' "$WANT" | sed 's/^"//; s/"$//') ;;
      \'*\') WANT=$(printf '%s' "$WANT" | sed "s/^'//; s/'$//") ;;
    esac

    grep -q "^${KEY}=" "$TMP" || continue                     # container never got it
    HAVE=$(grep "^${KEY}=" "$TMP" | head -1 | cut -d= -f2-)
    CHECKED=$((CHECKED + 1))

    if [ "$HAVE" != "$WANT" ]; then
      # A drifted value is very often a secret, so report the KEY and never the two
      # values: whoever runs this can already read .env, and a log or an alert that
      # quoted them would be a leak the check itself created.
      echo "DRIFT  $C  $KEY  (container holds a different value than .env)"
      DRIFT=1
    fi
  done < .env
done

# A run that compared nothing is not a pass. Without this, a stack whose containers
# are all gone, or an .env of nothing but comments, reports the same reassuring line
# as a genuinely clean one -- the check would be at its most silent exactly when it
# has stopped working.
if [ "$CHECKED" -eq 0 ]; then
  echo "check-env-drift: compared NOTHING — no .env key reached any container. Not a pass." >&2
  exit 2
fi

if [ "$DRIFT" -eq 0 ]; then
  echo "check-env-drift: no drift — all $CHECKED values a container was given match .env."
  exit 0
fi

cat >&2 <<'MSG'

Those containers are running values .env no longer says. Apply .env with:

    docker compose up -d

A `docker restart` will NOT do it, and neither will the next automatic update:
both keep the environment the container already has.
MSG
exit 1
