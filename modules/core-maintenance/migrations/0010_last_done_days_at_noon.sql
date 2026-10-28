-- Heal a schedule's last service day that was stored at midnight UTC (#8717).
--
-- A schedule's "last done" given as a bare day, "2026-04-09", was turned into
-- an instant with new Date(), which is midnight UTC. While every due date was
-- read in UTC that named the right day; once a workspace has its own zone, a
-- zone west of Greenwich reads it as the evening before, and every due date
-- worked out from it moved a day early. A day is now stored at noon UTC, the
-- platform's encoding of a day in an instant column (`instantOnDay`), read as
-- that day in every zone (`dayStoredAt`), the same heal 0008 made for visits.
--
-- Midnight UTC to the second is the bug's residue: a completion recorded from
-- a visit carries its own time, and the one case moved, a completion entered
-- at exactly 00:00 UTC, moves by twelve hours within the same UTC day.
update core_maintenance_schedules
   set last_done_at = last_done_at + interval '12 hours'
 where last_done_at is not null
   and last_done_at = date_trunc('day', last_done_at at time zone 'UTC') at time zone 'UTC';
