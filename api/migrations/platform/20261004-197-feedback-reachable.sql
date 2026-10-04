-- Whether anyone can be reached about a piece of feedback (#4645).
--
-- A try-sandbox guest has no account and an undeliverable address
-- (`sandbox-<handle>@try.invalid`), so "a reply goes to the reporter" was false
-- for them. The record now says so, decided where it is written, and every
-- surface reads it instead of guessing from the address.
--
-- Additive: reachable defaults true, the others are nullable.
alter table feedback add column if not exists reachable boolean not null default true;
alter table feedback add column if not exists unreachable_reason text;
-- An address a sandbox visitor chose to leave ("Email me when this is fixed"),
-- and when they agreed to be written to at it.
alter table feedback add column if not exists contact_email text;
alter table feedback add column if not exists contact_consented_at timestamptz;

-- Items already filed by a sandbox guest. Idempotent: only rows still marked
-- reachable and filed by a .invalid address change.
update feedback f
   set reachable = false, unreachable_reason = 'anonymous sandbox'
  from users u
 where u.id = f.user_id
   and u.email like '%@try.invalid'
   and f.reachable = true
   and f.contact_email is null;
