-- Field sections — group an entity kind's form fields under named headings
-- ("Specs", "Purchase info", …) for the visual form builder. A section is an
-- ordered heading per (org, entity_kind); each field optionally points at one
-- via section_id (null = ungrouped, renders above/after sections per the form).
-- Ordering is (section.position, field.position); a field's section + position
-- are set together by the form builder's reorder call.
--
-- ON DELETE SET NULL: deleting a section drops its fields back to ungrouped
-- rather than deleting them.
--
-- manual recovery if this fails partway:
--   alter table module_field_defs drop column if exists section_id;
--   alter table native_field_overrides drop column if exists section_id;
--   drop table if exists field_sections;
--   delete from migrations where name = '20260617-066-field-sections.sql';

create table field_sections (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references orgs(id) on delete cascade,
  entity_kind text not null,
  name        text not null,
  position    integer not null default 0,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index field_sections_lookup_idx on field_sections (org_id, entity_kind, position);

alter table module_field_defs
  add column section_id uuid references field_sections(id) on delete set null;
alter table native_field_overrides
  add column section_id uuid references field_sections(id) on delete set null;
