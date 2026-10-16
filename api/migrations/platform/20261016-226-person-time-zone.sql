-- Where a person is (#6815 follow-up): the IANA time zone their own browser
-- reports, so "today" on a quote, an invoice or a due date is their day. The
-- only zone the engine knew was the one on a notification delivery window, set
-- by the few who opened that page; everyone else got the day that has arrived
-- everywhere, a day behind for half the world each morning. Nullable: null
-- is "never said", which keeps that fallback.
--
-- manual recovery if this fails partway:
--   ALTER TABLE users DROP COLUMN IF EXISTS time_zone;
--   DELETE FROM migrations WHERE name = '20261016-226-person-time-zone.sql';

alter table users add column if not exists time_zone text;
