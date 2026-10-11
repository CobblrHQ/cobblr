-- Heal visits booked for a day that were stored at midnight UTC (#5759).
--
-- A date input sends a bare day, "2026-10-16", and the entries route turned it
-- into an instant with new Date(), which is midnight UTC: the evening of the
-- 15th anywhere west of Greenwich, so the record said "due 10/15". A day given
-- for this column is now stored at noon UTC, the platform's encoding of a day
-- in an instant column (`instantOnDay`), and read back as that day in every
-- zone (`dayStoredAt`).
--
-- Midnight UTC to the second is the bug's residue: the only other writers are
-- a schedule's own arithmetic, which steps from an earlier visit's instant, and
-- the edit form's date and time, where a person in UTC typing 00:00 is the one
-- case moved, by twelve hours within the same UTC day. Only open visits move;
-- a done one's due date is history and nothing counts to it.
update core_maintenance_entries
   set scheduled_at = scheduled_at + interval '12 hours'
 where performed_at is null
   and scheduled_at is not null
   and scheduled_at = date_trunc('day', scheduled_at at time zone 'UTC') at time zone 'UTC';
