-- core-tags: a tag can be PINNED, which keeps it at the front of every chip row
-- and exempts it from collapsing behind "+N".
--
-- Ordering became relevance-based (src/relevance.ts): broad and recently-used
-- tags first, spent event tags last. Any automatic ranking needs a manual
-- override, or the one tag you care about this week is unreachable and there is
-- nothing you can do about it.
--
-- Additive with a default, so it lands cleanly under the previously deployed
-- api: older readers never select this column, and every existing tag keeps
-- today's behaviour (unpinned).
--
-- manual recovery if this fails partway:
--   ALTER TABLE core_tags_tags DROP COLUMN pinned;
alter table core_tags_tags
  add column pinned boolean not null default false;

-- Ranking reads max(created_at) per tag on every list. The existing
-- core_tags_assignments_tag_idx already covers the lookup by tag_id; this adds
-- the timestamp so the aggregate is answered from the index rather than by
-- visiting the rows.
create index if not exists core_tags_assignments_tag_created_idx
  on core_tags_assignments(tag_id, created_at desc);
