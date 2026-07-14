-- module_field_defs.applies_to — TRAIT-SCOPED field defs (P1 of
-- docs/design-decisions/trait-scoped-fields.md).
--
-- Today a field def is keyed to exactly ONE entity_kind. A workspace that wants
-- "Origin — where I got this" on every PHYSICAL thing it tracks (parts, assets,
-- machines, places) has to create the same field once per kind, and re-create it
-- by hand whenever a new physical kind shows up. `applies_to` lets ONE row
-- declare a CLASS of kinds instead.
--
-- The value is the SAME predicate the action registry already matches
-- (`{ any } | { kinds?, traits?, hasFieldRole? }` — see platform/actions.ts
-- matchAction), so a scope is declared once and evaluated by ONE matcher, and
-- the 6-axis trait vocabulary (tangibility: physical|digital, …) is the language
-- of scopes. Null ⇒ per-kind, exactly today's behavior.
--
-- `entity_kind` stays NOT NULL: a trait-scoped row parks a scope SENTINEL there
-- (`@physical`), which keeps `unique (org_id, entity_kind, name)` meaningful —
-- one "origin" per scope per org. The resolver keys off applies_to; a sentinel is
-- never matched against a real kind (real ids are `module:kind`, never `@…`).
--
-- Additive + safe: NULL on every existing row, and the resolver treats null as
-- per-kind — nothing changes until a workspace creates a scoped field.
--
-- manual recovery if this fails partway:
--   ALTER TABLE module_field_defs DROP COLUMN IF EXISTS applies_to;
--   DELETE FROM migrations WHERE name = '20260713-085-field-def-applies-to.sql';

alter table module_field_defs
  add column if not exists applies_to jsonb;
