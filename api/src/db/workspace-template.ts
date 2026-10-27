// A new workspace's database cloned from one kept migrated (#5443).
//
// Making a workspace ran every migration on an empty database: the base, then
// each module's, about 7 s for one with every module on a quiet box (digifab's
// 76 files alone took 3 s). `CREATE DATABASE ... TEMPLATE` copies an 18 MB
// migrated one in under 200 ms. So a database migrated once is kept as a
// template, and a new workspace's is a copy of it, made its own:
//
//   - The template is named by a hash of every migration file it ran (and the
//     module set), so one built before a migration was added is never cloned:
//     a new hash names a template that does not exist yet, and until it is
//     built every workspace takes the full migration path. It is built under
//     another name and renamed only once whole, so a half-migrated template is
//     never cloned either.
//   - What belongs to one workspace is set after the copy: its owner (every
//     object the template's role made is handed to the workspace's user) and
//     its migration ledger, whose names carry the workspace's database and id.
//   - Two templates: `defaults`, what every workspace is born with, and `all`,
//     every module, for the test pool, which turns every module on anyway. A
//     signup never gets tables for modules it has not turned on.
//
// Off unless WORKSPACE_TEMPLATE is true. Phase 1 turns it on for CI's test api
// (its pool bake and the workspaces its tests make).

import { createHash, randomBytes } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { env } from "../env.js";
import { createClient, createPool } from "./client-error-guard.js";
import { runMigrations } from "./migrate.js";

export type TemplateSet = "defaults" | "all";

/** The role every template's objects belong to until a copy hands them on. */
export const TEMPLATE_ROLE = "cobblr_workspace_template";
/** Stands in for the workspace's database and id in the template's ledger. */
export const TEMPLATE_SCOPE_ID = "workspace-template";
/** Bump when how a template is built changes, so older ones are not cloned. */
const BUILDER_VERSION = 1;

const ident = /^[a-z0-9_]+$/;
const assertIdent = (s: string): string => {
  if (!ident.test(s)) throw new Error(`refusing an unsafe identifier: ${s}`);
  return s;
};

export interface TemplateModule {
  name: string;
  dependencies: readonly string[];
  /** Absent for a module with no tables. */
  migrationsDir: string | null;
}

/** The modules a template holds: every one for `all`, or what a new workspace
 *  is born with, and what those depend on. */
export async function templateModules(set: TemplateSet): Promise<TemplateModule[]> {
  const { listEntries, getEntry } = await import("../modules/registry.js");
  const { isDefaultModule } = await import("../modules/enable.js");
  const { isTrialDenied } = await import("../platform/trial.js");
  const wanted = new Map<string, TemplateModule>();
  const add = (name: string): void => {
    const entry = getEntry(name);
    if (!entry || wanted.has(entry.manifest.name)) return;
    wanted.set(entry.manifest.name, {
      name: entry.manifest.name,
      dependencies: entry.manifest.dependencies,
      migrationsDir: entry.manifest.schema ? resolve(entry.rootPath, entry.manifest.schema.migrationsDir) : null,
    });
    for (const d of entry.manifest.dependencies) add(d);
  };
  for (const e of listEntries()) {
    if (set === "all" ? !e.manifest.retirement : isDefaultModule(e) && !isTrialDenied(e.manifest.name)) add(e.manifest.name);
  }
  return [...wanted.values()].sort((a, b) => a.name.localeCompare(b.name));
}

async function filesOf(dir: string): Promise<Array<[string, string]>> {
  const names = (await readdir(dir).catch(() => [] as string[])).filter((n) => n.endsWith(".sql")).sort();
  return Promise.all(names.map(async (n) => [n, await readFile(join(dir, n), "utf8")] as [string, string]));
}

/** The hash a template is named by: the builder, the set, the base migrations
 *  and every module's, by name and content. Any change names a new template. */
export async function templateHash(set: TemplateSet, baseDir: string, modules: TemplateModule[]): Promise<string> {
  const h = createHash("sha256");
  h.update(`builder ${BUILDER_VERSION}\nset ${set}\n`);
  for (const [n, sql] of await filesOf(baseDir)) h.update(`base ${n}\n${sql}\n`);
  for (const m of modules) {
    h.update(`module ${m.name} deps ${[...m.dependencies].sort().join(",")}\n`);
    if (m.migrationsDir) for (const [n, sql] of await filesOf(m.migrationsDir)) h.update(`${m.name} ${n}\n${sql}\n`);
  }
  return h.digest("hex").slice(0, 16);
}

export const templateName = (set: TemplateSet, hash: string): string => assertIdent(`cobblr_tpl_${set}_${hash}`);

function superClient(database?: string) {
  const url = new URL(env.SUPERUSER_DATABASE_URL!);
  if (database) url.pathname = `/${database}`;
  return createClient({ connectionString: url.toString() }, `workspace template ${database ?? "superuser"}`);
}

/** The ledger's base and module scopes, as provision.ts and enable.ts write them. */
export const baseScope = (dbName: string): string => `tenant ${dbName}`;
export const moduleScope = (orgId: string, module: string): string => `tenant ${orgId} / module ${module}`;

/** Migrate the base and `modules` into the database `pool` reaches, in
 *  dependency order, four at a time. Any module that fails, or that a cycle
 *  left out, fails the whole run: a template is whole or not built. */
async function migrateInto(pool: ReturnType<typeof createPool>, baseDir: string, modules: TemplateModule[], base: string, orgId: string): Promise<void> {
  await runMigrations({ pool, directory: baseDir, scope: baseScope(base) });
  const { migrateConcurrently } = await import("../modules/migrate-concurrently.js");
  const entries = modules.map((m) => ({ rootPath: "", manifest: { name: m.name, dependencies: [...m.dependencies], schema: m.migrationsDir ? { migrationsDir: m.migrationsDir } : null } }));
  const failed: string[] = [];
  const waves = await migrateConcurrently(entries, async (e) => {
    try {
      await runMigrations({ pool, directory: e.manifest.schema!.migrationsDir, scope: moduleScope(orgId, e.manifest.name) });
    } catch (err) {
      failed.push(`${e.manifest.name}: ${(err as Error).message}`);
    }
  });
  const migrated = new Set(waves.flat());
  const left = entries.filter((e) => e.manifest.schema && !migrated.has(e.manifest.name)).map((e) => `${e.manifest.name}: never migrated (a dependency cycle)`);
  if (failed.length || left.length) throw new Error(`migrations failed: ${[...failed, ...left].join("; ")}`);
}

const known = new Map<TemplateSet, string>();
const building = new Map<TemplateSet, Promise<string | null>>();

/** The template to clone for `set`, when one for today's migrations is built;
 *  otherwise null, and one is started in the background, so this call and any
 *  before it is done take the full path. */
export async function readyTemplate(set: TemplateSet, baseDir: string): Promise<string | null> {
  const modules = await templateModules(set);
  const name = templateName(set, await templateHash(set, baseDir, modules));
  if (known.get(set) === name) return name;
  if (await templateExists(name)) {
    known.set(set, name);
    return name;
  }
  if (!building.has(set)) {
    const run = buildTemplate(set, baseDir, modules, name)
      .catch((err) => {
        console.error(`[workspace-template] building ${name} failed; workspaces take the full path:`, (err as Error).message);
        return null;
      })
      .finally(() => building.delete(set));
    building.set(set, run);
  }
  return null;
}

/** Build `set`'s template now and wait for it (tests, and a bake that wants it first). */
export async function buildTemplateNow(set: TemplateSet, baseDir: string): Promise<string> {
  const name = await buildTemplateOf(set, baseDir, await templateModules(set));
  known.set(set, name);
  return name;
}

/** Build the template of exactly `modules`, under the name their migrations
 *  hash to, and wait. Throws, and leaves no template, when any fails. */
export async function buildTemplateOf(set: TemplateSet, baseDir: string, modules: TemplateModule[]): Promise<string> {
  const name = templateName(set, await templateHash(set, baseDir, modules));
  if (!(await templateExists(name))) await buildTemplate(set, baseDir, modules, name);
  return name;
}

export async function templateExists(name: string): Promise<boolean> {
  const c = superClient();
  await c.connect();
  try {
    return ((await c.query("select 1 from pg_database where datname = $1", [name])).rowCount ?? 0) > 0;
  } finally {
    await c.end();
  }
}

/** Build a template under a working name and rename it once whole. One
 *  builder at a time across every api process (an advisory lock); one that
 *  finds it built by another does nothing. */
async function buildTemplate(set: TemplateSet, baseDir: string, modules: TemplateModule[], name: string): Promise<string> {
  const work = assertIdent(`${name}_b`);
  const started = performance.now();
  const c = superClient();
  await c.connect();
  try {
    await c.query("select pg_advisory_lock(hashtext('cobblr-workspace-template'))");
    if (((await c.query("select 1 from pg_database where datname = $1", [name])).rowCount ?? 0) > 0) return name;
    const password = randomBytes(24).toString("base64url");
    const role = (await c.query("select 1 from pg_roles where rolname = $1", [TEMPLATE_ROLE])).rowCount
      ? `ALTER ROLE ${TEMPLATE_ROLE} WITH LOGIN PASSWORD '${password}'`
      : `CREATE ROLE ${TEMPLATE_ROLE} WITH LOGIN PASSWORD '${password}'`;
    await c.query(role);
    await c.query(`DROP DATABASE IF EXISTS "${work}"`);
    // Owned by the superuser, not the role: a copy hands everything the role
    // owns to the workspace's user (REASSIGN OWNED), and that reaches the
    // databases the role owns too, which must never include a template.
    await c.query(`CREATE DATABASE "${work}"`);
    await c.query(`GRANT ALL ON DATABASE "${work}" TO ${TEMPLATE_ROLE}`);
    const inside = superClient(work);
    await inside.connect();
    try {
      await inside.query(`GRANT CREATE, USAGE ON SCHEMA public TO ${TEMPLATE_ROLE}`);
    } finally {
      await inside.end();
    }
    const url = new URL(env.DATABASE_URL);
    const pool = createPool({ host: url.hostname, port: url.port ? Number(url.port) : 5432, database: work, user: TEMPLATE_ROLE, password, max: 4 }, `workspace template ${work}`);
    try {
      await migrateInto(pool, baseDir, modules, TEMPLATE_SCOPE_ID, TEMPLATE_SCOPE_ID);
    } finally {
      await pool.end();
    }
    await c.query(`ALTER DATABASE "${work}" WITH ALLOW_CONNECTIONS false`);
    await c.query(`ALTER DATABASE "${work}" RENAME TO "${name}"`);
    // Older templates of this set: nothing clones them once a newer one exists
    // here, but a process still on older code might, and it falls back to the
    // full path when it finds one gone.
    const old = await c.query<{ datname: string }>("select datname from pg_database where datname like $1 and datname <> $2", [`cobblr_tpl_${set}_%`, name]);
    for (const { datname } of old.rows) await c.query(`DROP DATABASE IF EXISTS "${assertIdent(datname)}"`).catch(() => undefined);
    console.log(`[workspace-template] built ${name} (${modules.length} modules) in ${Math.round(performance.now() - started)}ms`);
    return name;
  } finally {
    await c.query("select pg_advisory_unlock(hashtext('cobblr-workspace-template'))").catch(() => undefined);
    await c.end();
  }
}

/** Make `dbName` a copy of `template`, owned by `userName`, its ledger naming
 *  this workspace. The superuser half (create, owner, connect rights) mirrors
 *  provision.ts's; the rest happens inside the copy. Returns the ledger's size. */
export async function cloneTemplate(template: string, dbName: string, userName: string, password: string, orgId: string, reset: boolean): Promise<number> {
  assertIdent(template);
  const escaped = password.replace(/'/g, "''");
  const c = superClient();
  await c.connect();
  try {
    if (reset) {
      await c.query(`DROP DATABASE IF EXISTS "${dbName}"`);
      await c.query(`DROP USER IF EXISTS "${userName}"`);
    }
    await c.query(`CREATE DATABASE "${dbName}" TEMPLATE "${template}"`);
    await c.query(`ALTER DATABASE "${dbName}" WITH ALLOW_CONNECTIONS true`);
    await c.query(`CREATE USER "${userName}" WITH LOGIN PASSWORD '${escaped}'`);
    await c.query(`ALTER DATABASE "${dbName}" OWNER TO "${userName}"`);
    await c.query(`GRANT CONNECT ON DATABASE "${dbName}" TO "${userName}"`);
    await c.query(`REVOKE CONNECT ON DATABASE "${dbName}" FROM PUBLIC`);
  } finally {
    await c.end();
  }
  const inside = superClient(dbName);
  await inside.connect();
  try {
    await inside.query("begin");
    await inside.query(`REASSIGN OWNED BY ${TEMPLATE_ROLE} TO "${userName}"`);
    await inside.query(`DROP OWNED BY ${TEMPLATE_ROLE}`);
    await inside.query("update migrations set name = $1 || substr(name, length($2) + 1) where name like $3", [
      `${baseScope(dbName)}::`,
      `${baseScope(TEMPLATE_SCOPE_ID)}::`,
      `${baseScope(TEMPLATE_SCOPE_ID)}::%`,
    ]);
    await inside.query("update migrations set name = $1 || substr(name, length($2) + 1) where name like $3", [
      `tenant ${orgId} / module `,
      `tenant ${TEMPLATE_SCOPE_ID} / module `,
      `tenant ${TEMPLATE_SCOPE_ID} / module %`,
    ]);
    await freshIds(inside);
    const n = Number((await inside.query("select count(*) from migrations")).rows[0].count);
    await inside.query("commit");
    return n;
  } catch (err) {
    await inside.query("rollback").catch(() => undefined);
    throw err;
  } finally {
    await inside.end();
  }
}

/** New ids for the rows the migrations seeded with random ones (inventory's
 *  first categories, labels' default templates): migrated the long way, each
 *  workspace drew its own, and a copy would otherwise keep the template's in
 *  every workspace. Every column a foreign key points at such an id follows
 *  it. Inside the copy's transaction, as the superuser. */
async function freshIds(c: { query: (q: string, v?: unknown[]) => Promise<{ rows: Array<Record<string, string>> }> }): Promise<void> {
  const keyed = (
    await c.query(`
      select n.nspname as s, cl.relname as t, a.attname as k, cl.oid::text as oid, a.attnum::text as num
        from pg_constraint p
        join pg_class cl on cl.oid = p.conrelid
        join pg_namespace n on n.oid = cl.relnamespace
        join pg_attribute a on a.attrelid = cl.oid and a.attnum = p.conkey[1]
        join pg_attrdef d on d.adrelid = cl.oid and d.adnum = a.attnum
       where p.contype = 'p' and array_length(p.conkey, 1) = 1 and a.atttypid = 'uuid'::regtype
         and pg_get_expr(d.adbin, d.adrelid) ~ '(gen_random_uuid|uuid_generate_v4)\\('
         and n.nspname not in ('pg_catalog', 'information_schema')`)
  ).rows;
  await c.query("set local session_replication_role = replica");
  for (const r of keyed) {
    const table = `"${r.s}"."${r.t}"`;
    if (!(await c.query(`select 1 from ${table} limit 1`)).rows.length) continue;
    await c.query(`create temp table template_ids on commit drop as select "${r.k}" as old, gen_random_uuid() as new from ${table}`);
    const refs = (
      await c.query(
        `select n.nspname as s, cl.relname as t, a.attname as k
           from pg_constraint f
           join pg_class cl on cl.oid = f.conrelid
           join pg_namespace n on n.oid = cl.relnamespace
           join pg_attribute a on a.attrelid = cl.oid and a.attnum = f.conkey[1]
          where f.contype = 'f' and f.confrelid = $1::oid and array_length(f.conkey, 1) = 1 and f.confkey[1] = $2::int2`,
        [r.oid, r.num],
      )
    ).rows;
    for (const ref of refs) await c.query(`update "${ref.s}"."${ref.t}" x set "${ref.k}" = m.new from template_ids m where x."${ref.k}" = m.old`);
    await c.query(`update ${table} x set "${r.k}" = m.new from template_ids m where x."${r.k}" = m.old`);
    await c.query("drop table template_ids");
  }
  await c.query("set local session_replication_role = origin");
}

/** Migrate a fresh database the long way, as a workspace's own user: the
 *  reference the clone is held equal to. */
export async function migrateFresh(dbName: string, userName: string, password: string, baseDir: string, modules: TemplateModule[], orgId: string): Promise<void> {
  const url = new URL(env.DATABASE_URL);
  const pool = createPool({ host: url.hostname, port: url.port ? Number(url.port) : 5432, database: dbName, user: userName, password, max: 4 }, `workspace fresh ${dbName}`);
  try {
    await migrateInto(pool, baseDir, modules, dbName, orgId);
  } finally {
    await pool.end();
  }
}
