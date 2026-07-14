-- workspace_module_instances.is_scan_fallback — the workspace's designated
-- catch-all for a scan the matchmaker can't confidently place.
--
-- A workspace accumulates several tables that overlap almost entirely (Home
-- Inventory, Household Supplies, Maker Workshop, Inventory). Asked one item at a
-- time to choose between near-synonyms, the matchmaker scatters items of the same
-- domain across all of them — there is no right answer to that question. The fix
-- is to stop asking it: unplaceable items go to ONE designated table and say what
-- they are via that table's `category` field (module_field_defs.field_role), and
-- a category that earns its own table can be promoted to an instance later.
--
-- WHY a flag and not "the module's default instance": a workspace's real
-- catch-all is usually a named instance it actually uses ("Home Inventory"), not
-- the bare auto-created default it never opens. The user picks. Absent a pick,
-- the reader falls back to the module's default instance, so this is inert until
-- someone sets it.
--
-- At most one fallback per (org, module): two catch-alls is no catch-all.
--
-- manual recovery if this fails partway:
--   ALTER TABLE workspace_module_instances DROP COLUMN IF EXISTS is_scan_fallback;
--   DELETE FROM migrations WHERE name = '20260714-087-instance-scan-fallback.sql';

alter table workspace_module_instances
  add column if not exists is_scan_fallback boolean not null default false;

create unique index if not exists workspace_module_instances_one_fallback_per_module
  on workspace_module_instances(org_id, module_name)
  where is_scan_fallback;
