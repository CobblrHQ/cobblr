-- Wires that text people outside the workspace (#6070, slice 3c).
--
-- The owner: an automation may ask the person who buys the coffee to get
-- more by text as well as by email, through the workspace's own Twilio
-- account, never Cobblr's. The same opt-in, limits, stop link and log as
-- the email (slice 3a).
--
-- workspace_people.phone: a number to text, in international form
--   (+15550100123). Null for most people.
-- org_outbound_sms: the workspace's own Twilio account (encrypted, never
--   in a backup), one per workspace.
-- external_message_log.channel: email or text, so the log says which.
--
-- Additive + safe: two nullable or defaulted columns and a new table.
--
-- manual recovery if this fails partway:
--   ALTER TABLE workspace_people DROP COLUMN IF EXISTS phone;
--   ALTER TABLE external_message_log DROP COLUMN IF EXISTS channel;
--   DROP TABLE IF EXISTS org_outbound_sms;
--   DELETE FROM migrations WHERE name = '20261013-220-text-someone-outside.sql';

alter table workspace_people
  add column if not exists phone text;

alter table external_message_log
  add column if not exists channel text not null default 'email';

create table if not exists org_outbound_sms (
  org_id      uuid primary key references orgs(id) on delete cascade,
  from_number text not null,
  config_enc  text not null,
  updated_by  uuid references users(id) on delete set null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
