-- Phase 1b of bundle-user-overrides: a JSONB `overrides` blob on the per-field
-- override layer. Phase 1a already does relabel / hide / reorder in dedicated
-- columns; the blob carries the OPEN-ended overrides — `choices` first (custom
-- dropdown options the user added that must survive a bundle update), and any
-- future presentation key — WITHOUT a schema change each time. The user layer
-- (bundle_id null) wins at resolve; the bundle's own row stays pristine, so the
-- "+ add option" clobber (a PATCH onto a bundle-owned field def) goes away.
--
-- Additive + safe: default '{}' applies to every existing row; nothing reads it
-- until the resolver opts in.
--
-- manual recovery if this fails partway:
--   ALTER TABLE native_field_overrides DROP COLUMN IF EXISTS overrides;
--   DELETE FROM migrations WHERE name = '20260616-062-field-override-blob.sql';

alter table native_field_overrides
  add column overrides jsonb not null default '{}'::jsonb;
