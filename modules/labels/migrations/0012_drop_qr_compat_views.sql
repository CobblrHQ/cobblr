-- Retire the compat views 0004 left at the former QR module's table names.
--
-- 0004 renamed that module's tables to the labels_ prefix and left a view at
-- each old name so an api image from before the merge kept working through a
-- rollout. Every deployed api has read the labels_ names since 0.6.0, and the
-- boot shim that converted each workspace's enablement is retired with this
-- change, so the views have no reader.
--
-- PHASE: contract
-- SAFE WHEN: every deployment's api is past labels 0.6.0 (the oldest serving,
--            the hosted product's nightly of 2026-09-29, is two months past it);
--            no code under api/ or modules/ names core_labels_qr_scans or
--            core_labels_qr_settings outside migration 0004.
--
-- Drops only a VIEW by that name: a workspace whose old table was never
-- renamed keeps it untouched rather than failing its migration.

do $$
begin
  if exists (select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
             where c.relname = 'core_labels_qr_scans' and c.relkind = 'v' and n.nspname = current_schema()) then
    drop view core_labels_qr_scans;
  end if;
  if exists (select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
             where c.relname = 'core_labels_qr_settings' and c.relkind = 'v' and n.nspname = current_schema()) then
    drop view core_labels_qr_settings;
  end if;
end $$;
