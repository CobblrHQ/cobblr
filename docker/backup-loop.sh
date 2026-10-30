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
#   1. EXIT STATUS, CONTENT AND SIZE must all pass. `pg_dumpall | gzip` reports gzip,
#      which succeeds on empty input, so a refused connection wrote a 20-byte
#      file and slept a day. That hid a three-day outage once and cost staging
#      a day in 2026-09. A gzip integrity check and the pg_dumpall completion
#      marker also catch output that is large but unfinished.
#   2. A FAILED DUMP RETRIES IN MINUTES, never tomorrow. The 20-byte dumps
#      happen while the db container is being recreated, which clears in
#      seconds; sleeping 24 h turned a blip into a day with no restore point.
#      `depends_on: service_healthy` does not prevent it (prod had it and still
#      hit the race).
#   3. RETENTION COUNTS ONLY VERIFIED DUMPS. A failed run leaves a file for
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
#   6. THE HOUR IS READ ON THE COPY'S CLOCK (BACKUP_TZ). The db image runs in
#      UTC, and a box's off-box timer runs in the box's zone, so BACKUP_AT=03:00
#      read on the container's clock dumped at 23:00 America/New_York, four
#      hours before a 03:40 copy instead of forty minutes (2026-09-23; the lag
#      check caught it the first night). BACKUP_TZ names the zone the hour is
#      read in; a zone the image cannot find is refused at boot, because musl
#      and busybox quietly fall back to UTC for a name they do not know, which
#      is this same error with no message. Without BACKUP_TZ the container's own
#      zone is used (TZ, or a mounted /etc/localtime), and the log says which.
#   7. A DUMP NEVER FILLS THE DISK IT READS FROM. Retention counted files, so
#      when one table made each dump ten times bigger (2026-10-19) thirty slots
#      became 42 GB, the disk the database lives on reached 0 bytes free, and
#      the 03:00 dump itself took the database into crash recovery (#8940).
#      Before a dump the loop wants twice the last dump plus a reserve free; it
#      makes room from failed partials, then from the oldest dumps (never the
#      newest BACKUP_DAILY_FLOOR), and if that is not enough it skips the dump
#      and fails loudly: a missed day, never a crashed database.
#      BACKUP_DAILY_MAX_BYTES caps what the daily dumps may hold in all.
#
# Env (every one has a default; a compose file overrides what it needs):
#   BACKUP_AT               local HH:MM to dump at, or "interval" to keep the
#                           old drifting behaviour (default 03:00)
#   BACKUP_TZ               the IANA zone BACKUP_AT is read in, e.g.
#                           Europe/Berlin: the zone your off-box copy runs in
#                           (default: the container's own zone, UTC unless TZ
#                           or /etc/localtime says otherwise)
#   BACKUP_PREFIX           dump filename prefix (default cobblr)
#   BACKUP_DIR              where dumps live (default /backups)
#   BACKUP_MIN_BYTES        the size floor a dump must clear (default 1000000)
#   BACKUP_DAILY_RETENTION  usable daily dumps to keep (default 30)
#   BACKUP_WEEKLY_RETENTION Sunday copies to keep (default 12)
#   BACKUP_MIN_FREE_BYTES   free space to leave on the disk after a dump the
#                           size of twice the last one (default 2147483648)
#   BACKUP_DAILY_MAX_BYTES  most bytes the daily dumps may hold together
#                           (default 0: no cap beyond the count)
#   BACKUP_DAILY_FLOOR      newest daily dumps space-pruning never removes
#                           (default 3)
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
RESERVE="${BACKUP_MIN_FREE_BYTES:-2147483648}"
DAILY_MAX="${BACKUP_DAILY_MAX_BYTES:-0}"
FLOOR="${BACKUP_DAILY_FLOOR:-3}"

# The clock BACKUP_AT is read on. Validated against the zone files rather than
# trusted, because an unknown name is silently UTC (see 6 above).
ZONEINFO_DIR="${ZONEINFO_DIR:-/usr/share/zoneinfo}"
if [ -n "${BACKUP_TZ:-}" ]; then
  case "$BACKUP_TZ" in
    *..*|/*|*[!A-Za-z0-9_+/-]*)
      echo "BACKUP_TZ must be an IANA zone name like Europe/Berlin, got: $BACKUP_TZ" >&2; exit 2 ;;
  esac
  if [ ! -f "$ZONEINFO_DIR/$BACKUP_TZ" ]; then
    echo "BACKUP_TZ=$BACKUP_TZ is not a zone this image knows ($ZONEINFO_DIR/$BACKUP_TZ is missing); refusing rather than dumping on UTC" >&2
    exit 2
  fi
  export TZ="$BACKUP_TZ"
fi
# The zone to name in the log: what we set, what TZ says, or what the mounted
# /etc/localtime resolves to, else UTC.
zone_name() {
  if [ -n "${TZ:-}" ]; then echo "$TZ"; return; fi
  local l
  l=$(readlink /etc/localtime 2>/dev/null) && [ -n "$l" ] && { echo "${l#*zoneinfo/}"; return; }
  [ -f /etc/timezone ] && { head -n1 /etc/timezone; return; }
  # A mounted /etc/localtime is a plain file with no name in it; the clock's
  # own abbreviation (UTC, CEST, EDT) is still true.
  date +%Z 2>/dev/null || echo "UTC"
}
ZONE="$(zone_name)"

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
  # has to name itself and what is accepted (docs/architecture/platform-spec.md §14.6).
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

# A published dump is readable by others: an off-box copy pulls it as a user
# that is not its owner (a restic job, a self-hoster's rsync). mktemp makes the
# partial 0600 and a rename keeps the mode, so it is set before the rename,
# whatever the umask (#8417; app's off-box copy failed on 2026-10-25).
PUBLISHED_MODE=0644
# One-shot heal for dumps published 0600 between #8295 and #8417. Only
# finished dumps: a .failed or .partial file is never published.
# DONE WHEN: no daily/ or weekly/ *.sql.gz on any box is 0600, so the last
# nightly from before #8417 has aged out of retention (30 daily, 12 weekly).
find "$DIR/daily" "$DIR/weekly" -maxdepth 1 -type f -name "$PREFIX-*.sql.gz" -perm 0600 \
  -exec chmod "$PUBLISHED_MODE" {} + 2>/dev/null || true

verified_dump() {
  local file="$1" bytes
  bytes=$(stat -c%s "$file" 2>/dev/null || echo 0)
  [ "$bytes" -ge "$MIN" ] || return 1
  gzip -t "$file" 2>/dev/null || return 1
  gzip -dc "$file" 2>/dev/null | tail -n 12 | grep -Fx -- '-- PostgreSQL database cluster dump complete' >/dev/null
}

free_bytes() { df -PB1 "$DIR/daily" 2>/dev/null | awk 'NR==2{print $4}'; }

# The daily dumps, newest first, past the floor: what space-pruning may take.
removable_dailies() { ls -1t "$DIR"/daily/*.sql.gz 2>/dev/null | tail -n +$(( FLOOR + 1 )); }

# Room for the next dump (7 above): failed partials go first, then the oldest
# dumps past the floor. Returns 1 when even that leaves too little.
make_room() {
  local last need free f
  last=$(ls -1t "$DIR"/daily/*.sql.gz 2>/dev/null | head -n1)
  need=$(( RESERVE + 2 * $( [ -n "$last" ] && stat -c%s "$last" 2>/dev/null || echo 0) ))
  free=$(free_bytes)
  [ -n "$free" ] || { echo "[backup] could not read free space on $DIR; dumping without the check"; return 0; }
  [ "$free" -ge "$need" ] && return 0
  echo "[backup] $free bytes free on $DIR, a dump wants $need: making room"
  for f in "$DIR"/daily/*.failed "$DIR"/daily/*.partial.*; do
    [ -e "$f" ] || continue
    rm -f "$f" && echo "[backup] removed $f for space"
    free=$(free_bytes); [ "$free" -ge "$need" ] && return 0
  done
  while f=$(removable_dailies | tail -n1) && [ -n "$f" ]; do
    rm -f "$f" && echo "[backup] removed the oldest dump $f for space"
    free=$(free_bytes); [ "$free" -ge "$need" ] && return 0
  done
  return 1
}

# One dump, judged. Prints its verdict; returns 0 only for a usable dump.
dump_once() {
  local stamp out partial failed ok sz
  stamp=$(date -u +%Y%m%dT%H%M%SZ)
  if ! make_room; then
    echo "[backup] $stamp SKIPPED - only $(free_bytes) bytes free on $DIR and nothing past the newest $FLOOR dumps left to remove; the database's disk is kept, not this dump"
    return 1
  fi
  out="$DIR/daily/$PREFIX-$stamp.sql.gz"
  echo "[backup] $stamp -> pg_dumpall -> $out"
  ok=1
  partial=$(mktemp "$DIR/daily/$PREFIX-$stamp.partial.XXXXXX") || return 1 # tmp-kept: published on success, kept for triage on failure; prune removes stale partials.
  pg_dumpall --clean --if-exists | gzip > "$partial" || ok=0
  sz=$(stat -c%s "$partial" 2>/dev/null || echo 0)
  if [ "$ok" = "1" ] && verified_dump "$partial"; then
    [ -e "$out" ] && out="$DIR/daily/$PREFIX-$stamp-${partial##*.}.sql.gz"
    chmod "$PUBLISHED_MODE" "$partial" && mv "$partial" "$out" || { echo "[backup] $stamp FAILED to publish $out"; return 1; }
    echo "[backup] $stamp done - $sz bytes"
    if [ "$(date +%u)" = "7" ]; then
      cp "$out" "$DIR/weekly/" && chmod "$PUBLISHED_MODE" "$DIR/weekly/${out##*/}" && echo "[backup] weekly copy"
    fi
    # The marker is what lets an off-box copy order itself after the dump
    # instead of guessing an hour (#3307). Written only for a dump that passed,
    # because a marker for a 20-byte file would tell the copy to ship nothing.
    printf '%s %s\n' "$stamp" "$out" > "$DIR/last-dump"
    return 0
  fi
  failed="$DIR/daily/$PREFIX-$stamp-${partial##*.}.failed"
  mv "$partial" "$failed" || return 1
  echo "[backup] $stamp FAILED - $sz bytes (floor $MIN, gzip integrity and dump completion required); kept for triage at $failed, NOT promoted to weekly"
  return 1
}

# Retention. Failed files prune on a shorter clock so they cannot hold a slot,
# and every `|| true` here is load-bearing: a `while` returns its LAST test, so
# a final undersized file would make the pipeline non-zero.
prune() {
  find "$DIR/daily" -type f \( -name '*.failed' -o -name '*.partial.*' \) -mmin +2880 -delete 2>/dev/null || true
  find "$DIR/daily" -name '*.sql.gz' -size -$(( MIN / 1024 ))k -mmin +2880 -delete 2>/dev/null || true
  { ls -1t "$DIR"/daily/*.sql.gz 2>/dev/null \
    | while read -r f; do verified_dump "$f" && echo "$f"; done \
    | tail -n +$(( DAILY + 1 )) | xargs -r rm -f; } || true
  { ls -1t "$DIR"/weekly/*.sql.gz 2>/dev/null \
    | while read -r f; do verified_dump "$f" && echo "$f"; done \
    | tail -n +$(( WEEKLY + 1 )) | xargs -r rm -f; } || true
  if [ "$DAILY_MAX" -gt 0 ]; then
    local total f
    total=$(stat -c%s "$DIR"/daily/*.sql.gz 2>/dev/null | awk '{t+=$1} END{print t+0}')
    while [ "$total" -gt "$DAILY_MAX" ] && f=$(removable_dailies | tail -n1) && [ -n "$f" ]; do
      total=$(( total - $(stat -c%s "$f") )); rm -f "$f" && echo "[backup] removed $f: daily dumps over BACKUP_DAILY_MAX_BYTES ($DAILY_MAX)"
    done
  fi
}

if [ "$ONCE" = "1" ]; then
  dump_once; rc=$?
  prune
  exit $rc
fi

echo "[backup] dumping at ${AT} local (${ZONE}), prefix ${PREFIX}, floor ${MIN} bytes"
[ "$ZONE" = "UTC" ] && [ "$AT" != "interval" ] && echo "[backup] note: ${AT} is read in UTC; set BACKUP_TZ to the zone your off-box copy runs in"
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
    echo "[backup] next dump at $AT local, in ${wait}s ($(date -d "@$(( $(date +%s) + wait ))" '+%Y-%m-%d %H:%M %Z' 2>/dev/null), ${ZONE})"
  fi
  sleep "$wait"
done
