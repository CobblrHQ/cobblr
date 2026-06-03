-- Per-kind presentation overrides for a module's NATIVE fields. field_defs
-- (entity-registry migration) ADD custom fields; this RELABELS and SHOW/HIDES
-- the native fields a module already declares (rename assets:asset's
-- "manufacturer" → "Make", hide "serial_number"/"excitement" on a vehicle).
-- Org-wide, like module_field_defs + entity_kind_overrides; a bundle seeds
-- them (bundle_id) and the workspace can tweak in Configuration → Presentation.
-- Targets per-instance automatically: an instance has its own kind id
-- (<instance>:item), so an override on that kind only affects that instance.
--
-- manual recovery if this fails partway:
--   DROP TABLE IF EXISTS native_field_overrides;
--   DELETE FROM migrations WHERE name = '20260603-037-native-field-overrides.sql';

create table native_field_overrides (
  id              uuid primary key default gen_random_uuid(),
  org_id          uuid not null references orgs(id) on delete cascade,
  entity_kind     text not null,
  name            text not null,          -- the native field's name (e.g. "manufacturer")
  display_label   text,                   -- null = keep the module's default label
  hidden          boolean not null default false,
  position        integer not null default 0,
  bundle_id       uuid references bundles(id) on delete set null,
  source_module   text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  -- one override per native field per kind per workspace
  unique (org_id, entity_kind, name)
);
create index native_field_overrides_org_kind_idx
  on native_field_overrides(org_id, entity_kind);
