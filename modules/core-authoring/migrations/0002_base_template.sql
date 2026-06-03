-- core-authoring — record which template a customize-template draft started
-- from. Additive + nullable (create-bundle drafts leave it null). Makes the
-- corpus queryable: "how often is each flagship template the base?" — a
-- signal for the templates-first flywheel (business-models/08). The full
-- chosen template also lives inside context_snapshot; this is the indexable
-- shortcut. See docs/architecture/templates-first-authoring.md.
--
-- manual recovery if this fails partway (per-tenant DB; tracked as
-- `tenant <orgId> / module core-authoring::0002_base_template.sql`):
--   ALTER TABLE core_authoring_drafts DROP COLUMN IF EXISTS base_template_id;
--   DELETE FROM migrations WHERE name LIKE '%module core-authoring::0002_base_template.sql';
alter table core_authoring_drafts
  add column base_template_id text;
