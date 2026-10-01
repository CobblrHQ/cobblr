-- core-documents: the documents a person keeps in a document system
-- (Paperless-ngx, or any other that answers documents.*), matched and linked
-- to the things they belong to. Tenant-scoped.
--
-- Cobblr keeps no document here, only what it needs to show one at once:
-- what was matched (suggestions), what a person linked (linked), and the
-- facts each record was last matched on (records). Every outside call happens
-- in the background; opening a record reads these tables and nothing else.
--
-- Record ids are text: a record is any kind's, and kinds key their rows their
-- own way. User ids are opaque (users live in cobblr_meta).

-- What each record was last matched on. A record whose facts change is
-- matched again; `status = 'queued'` is the work waiting for the sweep.
create table core_documents_records (
  record_kind   text not null,
  record_id     text not null,
  facts         jsonb not null default '{}'::jsonb,
  facts_key     text not null default '',
  status        text not null default 'queued' check (status in ('queued', 'done')),
  attempts      integer not null default 0,
  matched_at    timestamptz,
  -- Why the last ask did not get an answer (a system that did not answer),
  -- for the panel's "didn't answer" and Retry; null when it answered.
  last_error    text,
  updated_at    timestamptz not null default now(),
  primary key (record_id)
);
create index core_documents_records_queued_idx on core_documents_records (updated_at desc) where status = 'queued';

-- Documents that look like a record, found in the background. A suggestion
-- found through a person's OWN connection is theirs alone (for_user_id); one
-- found through a shared connection is the workspace's (null).
create table core_documents_suggestions (
  id            uuid primary key default gen_random_uuid(),
  record_kind   text not null,
  record_id     text not null,
  connection_id text not null,
  ref           text not null,
  title         text not null default '',
  created       text,
  tags          jsonb not null default '[]'::jsonb,
  open_url      text,
  has_thumb     boolean not null default false,
  score         real not null default 0,
  because       text,
  for_user_id   uuid,
  dismissed_at  timestamptz,
  found_at      timestamptz not null default now()
);
create unique index core_documents_suggestions_one_idx
  on core_documents_suggestions (record_id, connection_id, ref, coalesce(for_user_id::text, ''));
create index core_documents_suggestions_record_idx on core_documents_suggestions (record_id);

-- Documents a person linked to a record, with what the panel shows of them,
-- so a linked document is on the page with no outside call. The pairing
-- (has-document) is the link itself; this is its picture.
create table core_documents_linked (
  record_kind   text not null,
  record_id     text not null,
  connection_id text not null,
  ref           text not null,
  title         text not null default '',
  created       text,
  tags          jsonb not null default '[]'::jsonb,
  open_url      text,
  has_thumb     boolean not null default false,
  system_label  text not null default '',
  written_back  boolean not null default false,
  linked_by     uuid,
  linked_at     timestamptz not null default now(),
  primary key (record_id, connection_id, ref)
);

-- Per connection: when its documents were last read through for new ones (the
-- daily catch-up for anyone who skipped the webhook), and when it was first
-- seen (a new connection matches every record once).
create table core_documents_connections (
  connection_id  text primary key,
  first_seen_at  timestamptz not null default now(),
  caught_up_to   timestamptz,
  caught_up_at   timestamptz
);

-- One row: this workspace's existing records were queued once.
create table core_documents_state (
  id             boolean primary key default true check (id),
  backfilled_at  timestamptz
);
