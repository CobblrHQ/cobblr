-- Per-catalog source: where a catalog's ROWS live.
--   'local'  → the tenant DB (core_catalogs_entries), imported/pulled (today's
--              behaviour; the default so existing catalogs + self-host are
--              unchanged).
--   'hosted' → an operator-hosted shared reference service (the cloud
--              shared-catalog mode — docs/architecture/shared-reference-catalogs.md).
--              The shell + pairings stay local; only the rows are served from
--              the shared service. A catalog is only set 'hosted' when it is
--              hosted-ELIGIBLE (the resolver holds its dataset).
--
-- manual recovery if this fails partway:
--   ALTER TABLE core_catalogs_catalogs DROP COLUMN source;
--   DELETE FROM _prisma_migrations WHERE migration_name = '0003_source';
alter table core_catalogs_catalogs
  add column source text not null default 'local';
