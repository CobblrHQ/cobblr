-- builds Tier 2 — nested sub-assemblies.
--
-- A component line was always a leaf inventory part (part_id). This lets a line
-- instead point at ANOTHER build (sub_assembly_build_id) — a sub-assembly. The
-- build engine explodes nested sub-assemblies down to leaf inventory parts when
-- computing "how many can I build" and when consuming stock (BoM explosion).
--
-- sub_assembly_build_id IS a real FK (same module's table — not a cross-module
-- soft ref like part_id). on delete cascade: deleting a build also removes the
-- component lines that used it as a sub-assembly.
--
-- manual recovery if this fails partway:
--   ALTER TABLE builds_components DROP CONSTRAINT IF EXISTS builds_components_one_ref;
--   ALTER TABLE builds_components DROP COLUMN IF EXISTS sub_assembly_build_id;
--   ALTER TABLE builds_components ALTER COLUMN part_id SET NOT NULL;
--   DELETE FROM _prisma_migrations WHERE migration_name = '0002_nested_assemblies';

alter table builds_components
  add column sub_assembly_build_id uuid references builds_builds(id) on delete cascade;

-- part_id is no longer mandatory — a line is EITHER a leaf part OR a sub-assembly.
alter table builds_components
  alter column part_id drop not null;

-- Exactly one of (part_id, sub_assembly_build_id) must be set per line.
alter table builds_components
  add constraint builds_components_one_ref
  check (
    (part_id is not null and sub_assembly_build_id is null)
    or (part_id is null and sub_assembly_build_id is not null)
  );

create index builds_components_subassembly_idx
  on builds_components(sub_assembly_build_id)
  where sub_assembly_build_id is not null;
