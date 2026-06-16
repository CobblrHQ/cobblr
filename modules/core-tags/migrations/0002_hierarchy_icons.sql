-- core-tags: tag hierarchy (parent_id) + an icon (emoji glyph), for HomeBox parity.
-- parent_id self-references core_tags_tags. ON DELETE SET NULL so removing a parent
-- promotes its children to top-level rather than cascade-deleting them.
--
-- manual recovery if this fails partway:
--   ALTER TABLE core_tags_tags DROP COLUMN parent_id; ALTER TABLE core_tags_tags DROP COLUMN icon;
--   DELETE FROM _prisma_migrations WHERE migration_name = '0002_hierarchy_icons';
alter table core_tags_tags
  add column parent_id uuid references core_tags_tags(id) on delete set null,
  add column icon      text;

create index core_tags_tags_parent_idx on core_tags_tags(parent_id);
