-- core-discussion — a conversation on any record. Tenant-scoped.
--
-- The FOURTH polymorphic side-car, after tags, files and links: the source
-- triple is the same (source_module, source_type, source_id) shape they all
-- use, so no kind declares support and no module registers anything. A module
-- written next year gets discussion the way it already gets tags.
-- Spec: docs/design-decisions/discussion-and-the-side-rail.md
--
-- ONE conversation per record. The unique constraint is load-bearing, not
-- tidiness: a conversation is created lazily on first comment, so without it
-- two people commenting at the same moment on a fresh record would race into
-- two conversations on the same thing, each holding half the discussion.
--
-- User ids are OPAQUE here, with no foreign key: these are tenant tables and
-- users live in cobblr_meta, a different database. Display names resolve at the
-- API layer and are never stored (a stored name goes stale the moment someone
-- is renamed). Precedent: core-ai's chat turns do the same.

create extension if not exists "pgcrypto";

create table core_discussion_conversations (
  id            uuid primary key default gen_random_uuid(),
  -- source_type is always the BASE kind, never an instance name: an instance is
  -- a partition of the same table, and normalising here is what stops one
  -- record having two disjoint conversations depending on which page you
  -- commented from. The API enforces it; a test pins it.
  source_module text not null,
  source_type   text not null,
  source_id     uuid not null,
  resolved_at   timestamptz,
  resolved_by   uuid,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  unique (source_module, source_type, source_id)
);

create table core_discussion_comments (
  id              uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references core_discussion_conversations(id) on delete cascade,
  -- A REFERENCE, not a tree: replies render as a flat list with a quote
  -- (the Messenger model). Ships now, unrendered, so the reply UI is later a
  -- pure front-end change with no migration and no backfill.
  -- ON DELETE SET NULL would erase the distinction between "the quoted message
  -- was removed" and "this was never a reply", so deletion is a tombstone
  -- (deleted_at) and this FK never fires.
  in_reply_to     uuid references core_discussion_comments(id) on delete no action,
  author_kind     text not null default 'user',
  -- Null when the author is the assistant. Cobb never gets a users row: a
  -- synthetic user leaks into member lists, permission checks and every
  -- "who has access" screen forever.
  author_user_id  uuid,
  -- Who summoned Cobb. Assistant rows only, and the reason the UI can say
  -- "Cobb, asked by <whoever asked>" so readers know whose permissions produced an answer.
  requested_by    uuid,
  -- Assistant replies are asynchronous, so a comment exists before its text
  -- does. Without this, a failed invocation is indistinguishable from Cobb
  -- silently ignoring the question.
  status          text not null default 'posted',
  body            text not null default '',
  edited_at       timestamptz,
  -- Tombstone. The row survives so a reply quoting it can still say "message
  -- removed"; the body is cleared, so the text is genuinely gone.
  deleted_at      timestamptz,
  deleted_by      uuid,
  created_at      timestamptz not null default now(),
  constraint core_discussion_author_kind_ck check (author_kind in ('user', 'assistant')),
  constraint core_discussion_status_ck check (status in ('posted', 'pending', 'failed'))
);

-- The read path: every comment of one conversation, oldest first.
create index core_discussion_comments_conv_idx
  on core_discussion_comments(conversation_id, created_at);

-- The inline preview asks "does this record have a conversation, and how big".
create index core_discussion_conversations_source_idx
  on core_discussion_conversations(source_module, source_type, source_id);
