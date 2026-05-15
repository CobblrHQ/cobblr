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
}

export interface MigrationResult {
  applied: string[];
  alreadyApplied: number;
}

function storedName(scope: string, file: string): string {
  return `${scope}::${file}`;
}

export async function runMigrations(opts: MigrationRunOptions): Promise<MigrationResult> {
  const { pool, directory, scope } = opts;

  const client = await pool.connect();
  try {
    await bootstrapTrackerTable(client);
    const applied = await fetchAppliedNames(client, scope);
    const files = await listMigrationFiles(directory);
    const pending = files.filter((f) => !applied.has(f));

    const justRan: string[] = [];
    for (const file of pending) {
      const sql = await readFile(join(directory, file), "utf8");
      console.log(`[migrate:${scope}] applying ${file}`);
      await applyOne(client, scope, file, sql);
      justRan.push(file);
    }

    return { applied: justRan, alreadyApplied: applied.size };
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
