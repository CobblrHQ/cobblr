-- When this user last finished (or skipped) the guided tour.
--
-- Seen-state lived only in localStorage, which is per BROWSER and per ORIGIN.
-- That is three ways to forget something the person has already sat through:
--
--   a second browser or device            → toured again
--   the main host vs a preview host       → different origin, different store
--   cleared site data                     → gone
--
-- and the symptom people actually report is "entering a new workspace shows me
-- the tour again", because the tour only offers itself on an EMPTY workspace —
-- so a fresh workspace is exactly where a forgotten flag becomes visible.
--
-- The account is the right home, same as theme_pref and nav_pref beside it.
-- localStorage stays as a synchronous CACHE for the first paint (a tour that
-- flashes before the account loads is its own bug), but this is the record.
--
-- manual recovery:
--   ALTER TABLE users DROP COLUMN IF EXISTS tour_seen_at;

alter table users
  add column if not exists tour_seen_at timestamptz;

comment on column users.tour_seen_at is
  'When the guided tour was last completed or skipped. NULL = never. Account-level so it survives a new device, a different origin and a new workspace.';
