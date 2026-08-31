-- What the person actually asked for. The marketing form has two buttons now:
-- "Ask for a cloud invite" and "Just keep me posted". BOTH put you on the email
-- list; only the first is a request for hosted access.
--
-- Without this the two were indistinguishable in the queue (the kind was folded
-- into the free-text `source`), so pressing Approve on a self-hoster would mint
-- and email them a hosted invite they never asked for.
--
-- Additive: a default means every existing row reads as what it was, a request
-- for hosted access, which is what the single old button meant.
--
-- manual recovery if this fails partway:
--   ALTER TABLE waitlist DROP COLUMN IF EXISTS kind;
--   DELETE FROM migrations WHERE name = '20260901-116-waitlist-kind.sql';

alter table waitlist add column if not exists kind text not null default 'cloud';

-- The queue is worked by kind: pending cloud asks need a decision, self-host
-- signups never do.
create index if not exists waitlist_kind_status_idx on waitlist (kind, status, created_at desc);
