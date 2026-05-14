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

import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import type { Pool, PoolClient } from "pg";

export interface MigrationRunOptions {
  /** Pool pointing at the target DB. */
  pool: Pool;
  /** Absolute path to the directory containing the .sql files. */
  directory: string;
  /** Human label for log lines — "platform", "tenant <id>", etc. */
  scope: string;
}

export interface MigrationResult {
  applied: string[];
  alreadyApplied: number;
}

export async function runMigrations(opts: MigrationRunOptions): Promise<MigrationResult> {
  const { pool, directory, scope } = opts;

  const client = await pool.connect();
  try {
    await bootstrapTrackerTable(client);
    const applied = await fetchAppliedNames(client);
    const files = await listMigrationFiles(directory);
    const pending = files.filter((f) => !applied.has(f));

    const justRan: string[] = [];
    for (const file of pending) {
      const sql = await readFile(join(directory, file), "utf8");
      console.log(`[migrate:${scope}] applying ${file}`);
      await applyOne(client, file, sql);
      justRan.push(file);
    }

    return { applied: justRan, alreadyApplied: applied.size };
  } finally {
    client.release();
  }
}

async function bootstrapTrackerTable(client: PoolClient) {
  // The tracker table is special: it has to exist before we can
  // record anything in it. Idempotent — if it already exists this is
  // a no-op.
  await client.query(`
    create table if not exists migrations (
      id            serial primary key,
      name          text not null unique,
      applied_at    timestamptz not null default now()
    )
  `);
}

async function fetchAppliedNames(client: PoolClient): Promise<Set<string>> {
  const res = await client.query<{ name: string }>(
    "select name from migrations order by id"
  );
  return new Set(res.rows.map((r) => r.name));
}

async function listMigrationFiles(dir: string): Promise<string[]> {
  const all = await readdir(dir).catch(() => [] as string[]);
  return all.filter((f) => f.endsWith(".sql")).sort();
}

async function applyOne(client: PoolClient, name: string, sql: string) {
  await client.query("begin");
  try {
    await client.query(sql);
    await client.query("insert into migrations(name) values ($1)", [name]);
    await client.query("commit");
  } catch (err) {
    await client.query("rollback");
    throw new Error(`Migration ${name} failed: ${(err as Error).message}`);
  }
}
