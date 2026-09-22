#!/bin/bash
# The database dump loop, as a file instead of a compose string.
#
#   backup-loop.sh                      the loop (the container's entrypoint)
#   backup-loop.sh --once               one dump, then exit (an operator, a test)
#   backup-loop.sh --secs-until HH:MM   seconds until the next local HH:MM
#
# WHY IT IS A FILE. This loop existed four times: core's prod overlay, core's
# self-host template, the tracked compose in the ops repo, and whatever each box
# actually runs. They had already diverged in the way that matters -- on
# 2026-09-22 the tracked ops copy still trusted `if pg_dumpall | gzip; then`
# (the shape that reports a refused connection as a backup) and still pinned a
# postgres:17-alpine client against an 18 server, while the live box copy had
# both fixes. lint:backup-guards was written for exactly that class and could
# only read core's tree, so the copy nobody looked at was, again, the broken
# one. A script in the db image is read, tested and shipped once; a compose file
# names it and passes env.
#
# WHAT IT GUARANTEES, in the order the failures happened:
#   1. SIZE IS THE CHECK, not exit status. `pg_dumpall | gzip` reports gzip,
#      which succeeds on empty input, so a refused connection wrote a 20-byte
#      file and slept a day. That hid a three-day outage once and cost staging
#      a day in 2026-09.
#   2. A FAILED DUMP RETRIES IN MINUTES, never tomorrow. The 20-byte dumps
#      happen while the db container is being recreated, which clears in
#      seconds; sleeping 24 h turned a blip into a day with no restore point.
#      `depends_on: service_healthy` does not prevent it (prod had it and still
#      hit the race).
#   3. RETENTION COUNTS ONLY USABLE DUMPS. A failed run leaves a small file for
#      triage; letting those hold slots means a bad week evicts the good
#      backups underneath it.
#   4. THE DUMP HOUR IS CHOSEN, NOT INHERITED (BACKUP_AT, #3307). The old loop
#      slept 86400 s from whenever the container last started, so the hour
#      drifted with every `compose up` -- measured 2026-09-22 at 13:49 UTC on
#      the deploy box and 14:51 UTC on the trial box, while every off-box copy
#      runs from a timer at a fixed hour. The newest dump on the NAS was
#      therefore 17.9 h old at the moment it was copied, and up to 41.8 h old
#      before the next copy: the size of the data-loss window, set by accident.
#      An anchored hour is what lets a copy be ordered after it.
#   5. THE COPY CAN ORDER ITSELF. A completed dump writes <dir>/last-dump (the
#      stamp and the path), so a host-side timer or script can wait for today's
#      dump rather than hoping it already ran.
#
# Env (every one has a default; a compose file overrides what it needs):
#   BACKUP_AT               local HH:MM to dump at, or "interval" to keep the
#                           old drifting behaviour (default 03:00)
#   BACKUP_PREFIX           dump filename prefix (default cobblr)
#   BACKUP_DIR              where dumps live (default /backups)
#   BACKUP_MIN_BYTES        the size floor a dump must clear (default 1000000)
#   BACKUP_DAILY_RETENTION  usable daily dumps to keep (default 30)
#   BACKUP_WEEKLY_RETENTION Sunday copies to keep (default 12)
#   PG*                     passed to pg_dumpall as usual
#
# scripts/backup-loop.test.ts drives it with a fake pg_dumpall and a fake clock.
set -uo pipefail

DIR="${BACKUP_DIR:-/backups}"
PREFIX="${BACKUP_PREFIX:-cobblr}"
AT="${BACKUP_AT:-03:00}"
MIN="${BACKUP_MIN_BYTES:-1000000}"
DAILY="${BACKUP_DAILY_RETENTION:-30}"
WEEKLY="${BACKUP_WEEKLY_RETENTION:-12}"

# Seconds from now until the next local HH:MM. Never 0 (a zero would spin the
# loop through a whole day of dumps) and never more than 25 h.
#
# It asks `date` for tomorrow's HH:MM rather than adding 86400, because on a DST
# boundary the two are different: 03:00 the day after a spring-forward is
# 82800 s away, not 86400, and a loop that adds a day drifts an hour twice a
# year -- the same bug as the one above, only slower.
secs_until() {
  local hhmm="$1" now target day hh mm
  # RANGE-CHECKED, not glob-matched. A glob of [0-2][0-9]:[0-5][0-9] accepts
  # 25:00, which then failed `date` and returned 2 with NOTHING printed: the
  # container would exit on boot and the log would not say why. A wrong value
  # has to name itself and what is accepted (CLAUDE.md 14.6).
  bad_hour() { echo "BACKUP_AT must be HH:MM (00:00-23:59) or the word interval, got: $1" >&2; }
  case "$hhmm" in
    [0-9][0-9]:[0-9][0-9]) ;;
    *) bad_hour "$hhmm"; return 2 ;;
  esac
  hh="${hhmm%%:*}"; mm="${hhmm#*:}"
  # 10# so 08 is eight rather than a bad octal literal.
  if [ "$((10#$hh))" -gt 23 ] || [ "$((10#$mm))" -gt 59 ]; then
    bad_hour "$hhmm"; return 2
  fi
  now="${NOW_EPOCH:-$(date +%s)}"
  day=$(date -d "@$now" +%Y-%m-%d 2>/dev/null) \
    || { echo "BACKUP_AT: this date(1) cannot do -d @epoch" >&2; return 2; }
  target=$(date -d "$day $hhmm" +%s 2>/dev/null) \
    || { echo "BACKUP_AT: date(1) refused '$day $hhmm'" >&2; return 2; }
  if [ "$target" -le "$now" ]; then
    # Tomorrow's HH:MM, in local terms, asked of the calendar rather than
    # computed by adding a day.
    day=$(date -d "@$(( now + 86400 ))" +%Y-%m-%d 2>/dev/null) || return 2
    target=$(date -d "$day $hhmm" +%s 2>/dev/null) \
      || { echo "BACKUP_AT: date(1) refused '$day $hhmm'" >&2; return 2; }
  fi
  echo $(( target - now ))
}

if [ "${1:-}" = "--secs-until" ]; then
  secs_until "${2:?usage: backup-loop.sh --secs-until HH:MM}"
  exit $?
fi

ONCE=0
[ "${1:-}" = "--once" ] && ONCE=1

mkdir -p "$DIR/daily" "$DIR/weekly"

# One dump, judged. Prints its verdict; returns 0 only for a usable dump.
dump_once() {
  local stamp out ok sz
  stamp=$(date -u +%Y%m%dT%H%M%SZ)
  out="$DIR/daily/$PREFIX-$stamp.sql.gz"
  echo "[backup] $stamp -> pg_dumpall -> $out"
  ok=1
  pg_dumpall --clean --if-exists | gzip > "$out" || ok=0
  sz=$(stat -c%s "$out" 2>/dev/null || echo 0)
  if [ "$ok" = "1" ] && [ "$sz" -ge "$MIN" ]; then
    echo "[backup] $stamp done - $sz bytes"
    if [ "$(date +%u)" = "7" ]; then
      cp "$out" "$DIR/weekly/" && echo "[backup] weekly copy"
    fi
    # The marker is what lets an off-box copy order itself after the dump
    # instead of guessing an hour (#3307). Written only for a dump that passed,
    # because a marker for a 20-byte file would tell the copy to ship nothing.
    printf '%s %s\n' "$stamp" "$out" > "$DIR/last-dump"
    return 0
  fi
  echo "[backup] $stamp FAILED - $sz bytes (floor $MIN); kept for triage, NOT promoted to weekly"
  return 1
}

# Retention. Failed files prune on a shorter clock so they cannot hold a slot,
# and every `|| true` here is load-bearing: a `while` returns its LAST test, so
# a final undersized file would make the pipeline non-zero.
prune() {
  find "$DIR/daily" -name '*.sql.gz' -size -$(( MIN / 1024 ))k -mmin +2880 -delete 2>/dev/null || true
  { ls -1t "$DIR"/daily/*.sql.gz 2>/dev/null \
    | while read -r f; do [ "$(stat -c%s "$f")" -ge "$MIN" ] && echo "$f"; done \
    | tail -n +$(( DAILY + 1 )) | xargs -r rm -f; } || true
  { ls -1t "$DIR"/weekly/*.sql.gz 2>/dev/null | tail -n +$(( WEEKLY + 1 )) | xargs -r rm -f; } || true
}

if [ "$ONCE" = "1" ]; then
  dump_once; rc=$?
  prune
  exit $rc
fi

echo "[backup] dumping at ${AT} local, prefix ${PREFIX}, floor ${MIN} bytes"
fails=0
while true; do
  if dump_once; then fails=0; else fails=$(( fails + 1 )); fi
  prune
  if [ "$fails" -gt 0 ]; then
    # A failed dump must not cost a day of coverage.
    wait=$(( fails * 300 )); [ "$wait" -gt 3600 ] && wait=3600
    echo "[backup] retry $fails in ${wait}s (a failed dump does not wait a day)"
  elif [ "$AT" = "interval" ]; then
    wait=86400
    echo "[backup] sleeping ${wait}s (BACKUP_AT=interval: the hour drifts with this container's start)"
  else
    wait=$(secs_until "$AT") || exit 2
    echo "[backup] next dump at $AT local, in ${wait}s"
  fi
  sleep "$wait"
done
