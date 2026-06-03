-- Computed (template) field defs. A computed field has no stored value —
-- its value is RENDERED at entity-resolve time from a {{ }} template over
-- the entity's own fields (tier 1) plus registered context providers
-- (tier 2, e.g. {{maintenance.last_performed_at | relative}}). The
-- existing `type` column carries 'computed' as a new variant; `template`
-- holds the source string. Native value fields leave `template` null.
--
-- manual recovery if this fails partway:
--   ALTER TABLE module_field_defs DROP COLUMN IF EXISTS template;
--   DELETE FROM migrations WHERE name = '20260603-038-computed-field-defs.sql';

alter table module_field_defs add column if not exists template text;

-- Widen the type CHECK to admit 'computed' (was text/number/boolean/date/url).
alter table module_field_defs drop constraint if exists module_field_defs_type_check;
alter table module_field_defs add constraint module_field_defs_type_check
  check (type in ('text', 'number', 'boolean', 'date', 'url', 'computed'));
