-- core-discussion: who and what a comment names.
--
-- Two kinds of mention, one table:
--   user   — a person, notified because being named is different from activity
--            on something you happen to follow.
--   entity — a record. This one ALSO writes an entity_pairing, because a
--            mention is not a new link system: it is a writer for the one that
--            already exists, so a printer named in a document shows up under
--            Linked entities on both, using the table, the UI and the resolvers
--            that already ship on every detail page.
--
-- (An `assistant` mention — @cobb — is storable here too, so the summoning of
-- Cobb is a mention like any other rather than a special case parsed twice.)
--
-- Rows are DERIVED from the comment body and reconciled on every edit, so the
-- body stays the single source of truth. Nothing here is hand-maintained.

create table core_discussion_mentions (
  id            uuid primary key default gen_random_uuid(),
  comment_id    uuid not null references core_discussion_comments(id) on delete cascade,
  kind          text not null,
  -- kind='user': the person named. Opaque, no FK — users live in cobblr_meta.
  user_id       uuid,
  -- kind='entity': the record named, as the usual polymorphic triple.
  target_module text,
  target_type   text,
  target_id     uuid,
  created_at    timestamptz not null default now(),
  constraint core_discussion_mention_kind_ck check (kind in ('user', 'entity', 'assistant')),
  -- Each kind carries exactly the columns it means. Without this a row can say
  -- "entity" and name a user, and the reconcile would read it as neither.
  constraint core_discussion_mention_shape_ck check (
    (kind = 'user'      and user_id is not null and target_id is null) or
    (kind = 'entity'    and target_id is not null and target_module is not null
                        and target_type is not null and user_id is null) or
    (kind = 'assistant' and user_id is null and target_id is null)
  ),
  -- Naming the same thing twice in one comment is one mention.
  unique (comment_id, kind, user_id, target_module, target_type, target_id)
);

create index core_discussion_mentions_comment_idx on core_discussion_mentions(comment_id);
-- "who was named here" and "is this pairing still backed by a mention" both
-- read by target.
create index core_discussion_mentions_target_idx
  on core_discussion_mentions(target_module, target_type, target_id);
create index core_discussion_mentions_user_idx on core_discussion_mentions(user_id);
