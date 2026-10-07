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

// AHEAD is the third answer. Two api builds share one
// database on purpose (the canary channel: a main-tracking api beside the
// pinned one), so the pinned api finds ledgers holding migrations it never
// shipped. Its runner already said so quietly (describeUnknownMigrations);
// /healthz did not, and read every such pair as pending, which made the deploy
// gate refuse the pinned surface for being older than its peer, the one state
// the channel exists to have. A marker counts as ahead when the ledger holds
// MORE names than this build has files and its last name sorts at or after
// this build's newest: the peer is a descendant (it tracks main, the pinned
// api is a released main), so its ledger is a superset. A hole (a file of ours
// the ledger lacks) cannot hide there for long: this api's own boot opens
// every pair that is not exactly current and applies whatever is missing.

export interface ModuleMigrationFiles {
  /** Sorted-last `.sql` name on disk, or null when the module has no migrations. */
  latest: string | null;
  /** How many `.sql` files are on disk. */
  count: number;
  /** Every `.sql` name on disk. */
  names: ReadonlySet<string>;
}

export interface OrgModuleMarker {
  last_migration: string | null;
  migration_count: number | null;
  /** Newest ledger name an older api cannot survive, recorded by the api that
   *  applied it (db/migration-shape.ts); null for none. */
  newest_breaking_migration?: string | null;
}

export type MigrationState = "current" | "behind" | "ahead";

/** Where the ledger stands against this build's files. */
export function migrationState(row: OrgModuleMarker, files: ModuleMigrationFiles): MigrationState {
  if (files.latest === null) return "current"; // nothing on disk to apply
  if (row.migration_count === null) return "behind"; // never counted: look once
  if (row.last_migration === files.latest && row.migration_count === files.count) return "current";
  if (row.migration_count > files.count && row.last_migration !== null && row.last_migration >= files.latest) return "ahead";
  return "behind";
}

/** True when the tenant pool must be opened and runMigrations asked. Ahead
 *  is opened too: it is the one exact look (the ledger's names), and the
 *  runner applies any hole and logs the peer's names as expected. */
export function moduleIsBehind(row: OrgModuleMarker, files: ModuleMigrationFiles): boolean {
  return migrationState(row, files) !== "current";
}

/** What /healthz says about one pair. Ahead is information only when a
 *  peer is DECLARED to share this database (COBBLR_SHARED_DB_PEER) and it
 *  applied nothing that breaks an older reader that this build never
 *  shipped. Without a peer, ahead is a downgrade (an older image on a newer
 *  schema), and a breaking migration from the peer changed what this build
 *  reads: both stay pending, which the deploy gate refuses. */
export function healthVerdict(
  row: OrgModuleMarker,
  files: ModuleMigrationFiles,
  sharedDbPeer: string | undefined,
): "current" | "pending" | "ahead" {
  const state = migrationState(row, files);
  if (state === "current") return "current";
  if (state === "behind") return "pending";
  if (!sharedDbPeer?.trim()) return "pending";
  const breaking = row.newest_breaking_migration;
  if (breaking && !files.names.has(breaking)) return "pending";
  return "ahead";
}

export type PendingCause = "own" | "downgrade" | "peer_breaking";

/** WHY healthVerdict said pending, null when it did not: a migration of this
 *  build's own never applied, a newer ledger with no declared peer (a
 *  downgrade), or a declared peer's breaking migration this build never
 *  shipped. The gate refuses all three; the deploy reader names the one it
 *  is, because it once listed "no declared peer" first for a refusal whose
 *  peer was declared (canary's inventory 0019, 2026-10-06). Same branches as
 *  healthVerdict, so the two cannot disagree. */
export function pendingCause(row: OrgModuleMarker, files: ModuleMigrationFiles, sharedDbPeer: string | undefined): PendingCause | null {
  const state = migrationState(row, files);
  if (state === "current") return null;
  if (state === "behind") return "own";
  if (!sharedDbPeer?.trim()) return "downgrade";
  const breaking = row.newest_breaking_migration;
  if (breaking && !files.names.has(breaking)) return "peer_breaking";
  return null;
}

/** The newer of two ledger names, null-aware (names sort in the order they run). */
export function newerName(a: string | null | undefined, b: string | null | undefined): string | null {
  if (!a) return b ?? null;
  if (!b) return a;
  return a >= b ? a : b;
}

/** The files as the runner sees them: sorted by full name, `.sql` only. */
export function describeMigrationFiles(names: string[]): ModuleMigrationFiles {
  const files = names.filter((f) => f.endsWith(".sql")).sort();
  return { latest: files.length ? files[files.length - 1]! : null, count: files.length, names: new Set(files) };
}
