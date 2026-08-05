// Hand-rolled SQL migration runner. Three migration sets eventually
// share this code:
//
//   migrations/platform/     run once on cobblr_meta
//   migrations/tenant-base/  run on each new tenant DB at provision
//   modules/<m>/migrations/  run on a tenant DB when module <m> enables
//
// Each runner instance is scoped to one DB connection — pass in the
// Pool you want migrations to run against. Tracking lives in a
// `migrations` table inside that same DB so a failure of one tenant's
// migration set never blocks the others.
//
// Files are plain .sql, named `<timestamp>-<NNN>-<slug>.sql`. They run
// alphabetically; that's the source of truth for order. Each runs in
// its own transaction — partial application can't happen.
//
// Stored row name = `<scope>::<filename>` so two scopes' migrations
// with the same filename (very common — every module has its own
// 0001_init.sql) coexist in one tenant DB's migrations table.
//
// CONCURRENCY: more than one api process can boot against the same DB at the
// same time (the canary channel, a rolling promote, a box reboot bringing every
// container up at once). The whole run is therefore serialised behind a
// per-(database, scope) advisory lock — see acquireScopeLock.

import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import type { Pool, PoolClient } from "pg";

export interface MigrationRunOptions {
  /** Pool pointing at the target DB. */
  pool: Pool;
  /** Absolute path to the directory containing the .sql files. */
  directory: string;
  /** Human label for log lines AND the namespace key in the tracker
   *  table — distinct scopes must use distinct strings or migrations
   *  with identical filenames will collide. */
  scope: string;
  /** Name of another deployment that shares this database and is expected to be
   *  AHEAD of this build (the canary channel). Defaults to
   *  `COBBLR_SHARED_DB_PEER`, so a NEW call site is correct because it exists —
   *  there is nothing to remember to pass, and a forgotten one cannot bring the
   *  false alarm back. Pass explicitly only to override (the tests do).
   *  See describeUnknownMigrations. */
  sharedDbPeer?: string | undefined;
}

export interface MigrationResult {
  applied: string[];
  alreadyApplied: number;
}

function storedName(scope: string, file: string): string {
  return `${scope}::${file}`;
}

/** Namespace for every advisory lock this file takes, so a key can never
 *  collide with an unrelated one elsewhere in the codebase. */
const MIGRATION_LOCK_NAMESPACE = 0x0c0b;

/** Stable 31-bit key from a scope name (FNV-1a). Postgres's two-arg
 *  `pg_advisory_lock(int4, int4)` wants a signed int, so mask to 31 bits. */
export function scopeLockKey(scope: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < scope.length; i++) {
    h ^= scope.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h & 0x7fffffff;
}

/**
 * Serialise the whole run for this (database, scope).
 *
 * WHY THE WHOLE RUN, AND WHY BEFORE THE BOOTSTRAP: two processes that both read
 * `pending` before either commits will both try to apply the same file. The
 * files are not idempotent (`ALTER TABLE ... ADD COLUMN` without IF NOT EXISTS
 * is the norm), so the loser dies on "column already exists", `runMigrations`
 * throws, and boot() has no catch — the container crashloops until the winner's
 * work makes the file non-pending. `create table if not exists migrations` races
 * too: concurrent execution can fail on a duplicate-key error in the system
 * catalogs. So the lock covers the bootstrap, the read AND the apply loop, and
 * the loser re-reads `applied` only after the winner has committed.
 *
 * Advisory locks are scoped to one DATABASE, and each tenant has its own, so
 * tenants never queue behind each other.
 */
async function acquireScopeLock(client: PoolClient, scope: string): Promise<void> {
  await client.query("select pg_advisory_lock($1, $2)", [
    MIGRATION_LOCK_NAMESPACE,
    scopeLockKey(scope),
  ]);
}

async function releaseScopeLock(client: PoolClient, scope: string): Promise<void> {
  // Best-effort: a dropped connection releases session locks on its own, so a
  // failure here must never mask the original error.
  try {
    await client.query("select pg_advisory_unlock($1, $2)", [
      MIGRATION_LOCK_NAMESPACE,
      scopeLockKey(scope),
    ]);
  } catch {
    /* connection already gone — Postgres has released it for us */
  }
}

export interface UnknownMigrationReport {
  level: "error" | "info";
  message: string;
}

/**
 * How to report migrations the DB has applied but this build does not ship.
 *
 * Two very different situations produce the identical symptom:
 *
 *  1. A genuine DOWNGRADE — someone rolled an image back onto a newer schema.
 *     Unsupported, and it must stay loud.
 *  2. The canary channel — a main-tracking api deliberately shares this
 *     database and is expected to be ahead. See
 *     docs/design-decisions/canary-channel.md.
 *
 * Before this split, (2) logged (1)'s message on every boot of the pinned api.
 * A permanent false alarm is worse than no alarm: it trains everyone to scroll
 * past the line that is supposed to catch a real downgrade. `COBBLR_SHARED_DB_PEER`
 * names the channel that is allowed to be ahead, and is set ONLY on the stack
 * that is deliberately behind one.
 */
export function describeUnknownMigrations(
  scope: string,
  unknown: string[],
  sharedDbPeer: string | undefined,
): UnknownMigrationReport | null {
  if (unknown.length === 0) return null;
  const sample = `${unknown.slice(0, 3).join(", ")}${unknown.length > 3 ? ", …" : ""}`;
  const peer = sharedDbPeer?.trim();
  if (peer) {
    return {
      level: "info",
      message:
        `[migrate:${scope}] ${unknown.length} migration(s) applied by '${peer}', which shares this ` +
        `database and tracks a newer build (${sample}). Expected — this stack is pinned and '${peer}' is not. ` +
        `Migrations are additive by policy (lint:migration-additive), so this build reads the schema fine. ` +
        `See docs/design-decisions/canary-channel.md.`,
    };
  }
  return {
    level: "error",
    message:
      `[migrate:${scope}] ⚠ DOWNGRADE DETECTED — the database has ${unknown.length} applied ` +
      `migration(s) this build does not ship (${sample}). ` +
      `An older api image is running against a newer schema. This is unsupported: ` +
      `roll the image forward, or restore the DB from a backup taken before the newer image ran. ` +
      `See docs/operations/PRODUCTION_DEPLOY.md ("No downgrades").`,
  };
}

export async function runMigrations(opts: MigrationRunOptions): Promise<MigrationResult> {
  const { pool, directory, scope, sharedDbPeer } = opts;

  const client = await pool.connect();
  try {
    await acquireScopeLock(client, scope);
    try {
      await bootstrapTrackerTable(client);
      const applied = await fetchAppliedNames(client, scope);
      const files = await listMigrationFiles(directory);
      const pending = files.filter((f) => !applied.has(f));

      // The DB has applied migrations this build has never heard of. Warn,
      // don't crash: crashing would turn every emergency image rollback into
      // an outage. See describeUnknownMigrations for why the level varies.
      const onDisk = new Set(files);
      const unknown = [...applied].filter((f) => !onDisk.has(f));
      // `||`, not `??` — compose passes ${VAR:-} as an EMPTY STRING, and `??`
      // would accept "" as a real value and silence the downgrade alarm (§14.6).
      // NB: read via process.env rather than importing the validating `env`
      // module, which would make this low-level runner un-importable (and so
      // untestable) outside a full production environment.
      const peer = sharedDbPeer || process.env.COBBLR_SHARED_DB_PEER || undefined;
      const report = describeUnknownMigrations(scope, unknown, peer);
      if (report?.level === "error") console.error(report.message);
      else if (report) console.log(report.message);

      const justRan: string[] = [];
      for (const file of pending) {
        const sql = await readFile(join(directory, file), "utf8");
        console.log(`[migrate:${scope}] applying ${file}`);
        await applyOne(client, scope, file, sql);
        justRan.push(file);
      }

      return { applied: justRan, alreadyApplied: applied.size };
    } finally {
      await releaseScopeLock(client, scope);
    }
  } finally {
    client.release();
  }
}

async function bootstrapTrackerTable(client: PoolClient) {
  // Idempotent — same DDL whether the tenant DB is fresh or already
  // has the table from a prior boot.
  await client.query(`
    create table if not exists migrations (
      id            serial primary key,
      name          text not null unique,
      applied_at    timestamptz not null default now()
    )
  `);
}

async function fetchAppliedNames(client: PoolClient, scope: string): Promise<Set<string>> {
  const prefix = `${scope}::`;
  const res = await client.query<{ name: string }>(
    "select name from migrations where name like $1 order by id",
    [`${prefix}%`],
  );
  return new Set(res.rows.map((r) => r.name.slice(prefix.length)));
}

async function listMigrationFiles(dir: string): Promise<string[]> {
  // Don't swallow readdir errors — a missing migrations directory
  // is a configuration bug worth surfacing immediately rather than
  // silently treating as "zero migrations". The caller can catch
  // ENOENT explicitly if it ever wants the empty-set behaviour.
  const all = await readdir(dir);
  return all.filter((f) => f.endsWith(".sql")).sort();
}

async function applyOne(client: PoolClient, scope: string, file: string, sql: string) {
  await client.query("begin");
  try {
    await client.query(sql);
    await client.query("insert into migrations(name) values ($1)", [storedName(scope, file)]);
    await client.query("commit");
  } catch (err) {
    await client.query("rollback");
    throw new Error(`Migration ${file} failed: ${(err as Error).message}`);
  }
}
