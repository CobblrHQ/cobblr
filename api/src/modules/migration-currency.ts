// Is a workspace's module current with the migrations on disk? The decision,
// with no database in it, so a test can hold it to today's shape.
//
// The boot-time sync (syncTenantMigrations) must not open a tenant pool for
// every (workspace, module) pair on every boot, so it decides from the meta
// table alone. It used to compare `org_modules.last_migration` with the
// module's SORTED-LAST migration filename, on the belief that "a new migration
// always sorts later". Two migrations sharing an ordinal break that belief:
// on 2026-09-13 core-scan gained `0027_batch_read_state.sql` while every
// workspace already had `0027_inbox_placed_at.sql` as its last, `b` sorts
// before `i`, the sorted-last name did not move, every workspace read as
// current, and the file was not applied for four hours while the inbox list
// selected a column that did not exist (#2944). The runner underneath keys on
// full filenames and would have applied it; it was never asked.
//
// So the marker is two numbers, not one name: the last applied name AND how
// many the ledger holds. Migrations are immutable and never deleted, so a file
// inserted anywhere in the order changes the count. A NULL count is a workspace
// from before the column existed: unknown, so it is opened once, the count is
// written, and the next boot is cheap again (the self-heal §8.1 asks for).

export interface ModuleMigrationFiles {
  /** Sorted-last `.sql` name on disk, or null when the module has no migrations. */
  latest: string | null;
  /** How many `.sql` files are on disk. */
  count: number;
}

export interface OrgModuleMarker {
  last_migration: string | null;
  migration_count: number | null;
}

/** True when the tenant pool must be opened and runMigrations asked. */
export function moduleIsBehind(row: OrgModuleMarker, files: ModuleMigrationFiles): boolean {
  if (files.latest === null) return false; // nothing on disk to apply
  if (row.migration_count === null) return true; // never counted: look once
  return row.last_migration !== files.latest || row.migration_count !== files.count;
}

/** The files as the runner sees them: sorted by full name, `.sql` only. */
export function describeMigrationFiles(names: string[]): ModuleMigrationFiles {
  const files = names.filter((f) => f.endsWith(".sql")).sort();
  return { latest: files.length ? files[files.length - 1]! : null, count: files.length };
}
