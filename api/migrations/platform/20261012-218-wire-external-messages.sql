-- Wires that message people outside the workspace (#6070, slice 3a).
--
-- The owner: an automation may email someone who is not a member (the
-- person who buys the coffee), but only through the workspace's own email
-- sender, never Cobblr's, only once an owner or admin has said yes, within
-- daily limits, and with a way for the recipient to stop it.
--
-- entity_action_bindings.created_by: the member who made a wire, the
--   person an external message names as having set it up (outbound
--   email's `sentBy`). Null for a wire made before this, or by a bundle.
-- org_external_messages: the workspace's yes (off until an owner or admin
--   turns it on), its daily limit and each wire's, and who turned it on
--   (named for a wire with no creator).
-- external_message_log: every external message an automation tried:
--   sent, held (over a limit), stopped (the recipient said stop), or
--   refused (the switch off, no sender). What the limits count.
-- external_message_stops: a recipient who asked to stop a wire's messages.
--
-- Additive + safe: a nullable column and three new tables.
--
-- manual recovery if this fails partway:
--   ALTER TABLE entity_action_bindings DROP COLUMN IF EXISTS created_by;
--   DROP TABLE IF EXISTS external_message_stops, external_message_log, org_external_messages;
--   DELETE FROM migrations WHERE name = '20261012-218-wire-external-messages.sql';

alter table entity_action_bindings
  add column if not exists created_by uuid;

create table if not exists org_external_messages (
  org_id uuid primary key references orgs(id) on delete cascade,
  enabled boolean not null default false,
  daily_limit integer not null default 20,
  per_wire_daily_limit integer not null default 5,
  updated_by uuid,
  updated_at timestamptz not null default now()
);

create table if not exists external_message_log (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id) on delete cascade,
  binding_id uuid,
  person_id uuid,
  to_address text not null,
  -- what it said, footer and stop link included: what the admins see sent.
  body text,
  record_kind text,
  record_id text,
  status text not null,
  reason text,
  outbound_log_id uuid,
  created_at timestamptz not null default now()
);
create index if not exists external_message_log_org_day on external_message_log (org_id, created_at);
create index if not exists external_message_log_wire_day on external_message_log (binding_id, created_at);

create table if not exists external_message_stops (
  org_id uuid not null references orgs(id) on delete cascade,
  binding_id uuid not null,
  person_id uuid not null,
  stopped_at timestamptz not null default now(),
  primary key (org_id, binding_id, person_id)
);
