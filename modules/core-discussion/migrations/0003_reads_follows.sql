-- core-discussion: what you have read, and what you are following.
--
-- Both are per-user and per-record, and both are what turn a pile of
-- conversations into something you can keep up with. Without them a comment is
-- posted into a void: nobody learns it happened unless they open the record.
--
-- User ids stay opaque (tenant tables, users in cobblr_meta), as everywhere
-- else in this module.

create table core_discussion_reads (
  conversation_id uuid not null references core_discussion_conversations(id) on delete cascade,
  user_id         uuid not null,
  last_read_at    timestamptz not null default now(),
  primary key (conversation_id, user_id)
);

create table core_discussion_follows (
  -- The RECORD, not the conversation: you start following by commenting, and
  -- at that moment the conversation exists — but following a record you have
  -- not spoken on yet should not require inventing one.
  source_module text not null,
  source_type   text not null,
  source_id     uuid not null,
  user_id       uuid not null,
  -- Why, so the UI can say "you follow this because you commented" and so an
  -- explicit follow is not silently undone by an unfollow-on-quiet rule later.
  reason        text not null default 'commented',
  created_at    timestamptz not null default now(),
  primary key (source_module, source_type, source_id, user_id),
  constraint core_discussion_follow_reason_ck
    check (reason in ('commented', 'mentioned', 'explicit'))
);

-- "What is new for me" reads by user across every conversation.
create index core_discussion_reads_user_idx on core_discussion_reads(user_id);
create index core_discussion_follows_user_idx on core_discussion_follows(user_id);
