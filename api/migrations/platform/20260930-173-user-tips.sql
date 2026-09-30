-- The tips a person has been shown and the ones they dismissed:
--   { "shown": { "<tip id>": "<first shown at>" }, "dismissed": { "<tip id>": "<at>" } }
--
-- A tip ("install the app", and whatever modules add) shows one at a time, at
-- most one new one a day, and a dismissal is final. Those are facts about the
-- PERSON, so they live on the account like tour_seen_at beside them: a second
-- device, a cleared browser or another origin must not bring a dismissed tip
-- back. (A fact about the DEVICE, such as whether this phone has the app
-- installed, stays on the device.)
--
-- manual recovery:
--   ALTER TABLE users DROP COLUMN IF EXISTS tips;

alter table users
  add column if not exists tips jsonb not null default '{}'::jsonb;

comment on column users.tips is
  'Tips shown and dismissed, per tip id: { shown: {id: first shown at}, dismissed: {id: at} }. Account-level so a dismissal holds on every device.';
