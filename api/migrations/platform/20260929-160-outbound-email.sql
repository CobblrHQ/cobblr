-- A workspace's own outbound email: how Cobblr mails somebody who is not a
-- member of the workspace, such as a shop's customer, from the shop's own
-- address (#4051). Cobblr hosts no outbound mail and the hosted service's
-- mailer never mails third parties, so this is the only door: the workspace
-- brings its provider (the same shapes as the notification email channel),
-- and nothing is sent to a non-member without it.
--
-- config_enc holds the whole provider config, AES-GCM with the org's key
-- (encryptCredentials), never returned to a client.
--
-- outbound_email_log is every send through that door, one row each, written
-- by the one function that sends, so "was this person emailed, by whom, when"
-- has an answer that does not depend on the caller remembering to say so.
--
-- manual recovery if this fails partway:
--   drop table if exists outbound_email_log;
--   drop table if exists org_outbound_email;
--   delete from migrations where name = '20260929-160-outbound-email.sql';

create table if not exists org_outbound_email (
  org_id        uuid primary key references orgs(id) on delete cascade,
  provider      text not null check (provider in ('smtp', 'mailgun', 'resend', 'postmark')),
  from_address  text not null,
  config_enc    text not null,
  updated_by    uuid references users(id) on delete set null,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create table if not exists outbound_email_log (
  id            uuid primary key default gen_random_uuid(),
  org_id        uuid not null references orgs(id) on delete cascade,
  to_address    text not null,
  subject       text not null,
  -- The member who pressed send. Never null for a send to a third party: an
  -- automated send has no person, and none exists (see outbound-email.ts).
  sent_by       uuid references users(id) on delete set null,
  -- What the mail is about, e.g. ('sales:order', <id>).
  source_kind   text,
  source_id     text,
  status        text not null check (status in ('sent', 'failed', 'skipped')),
  message_id    text,
  error         text,
  created_at    timestamptz not null default now()
);

create index if not exists outbound_email_log_org_idx on outbound_email_log (org_id, created_at desc);
create index if not exists outbound_email_log_source_idx on outbound_email_log (org_id, source_kind, source_id);
