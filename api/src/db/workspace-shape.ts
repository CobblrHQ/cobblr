// What a workspace CARRIES, as data two workspaces can be diffed on.
//
// CI hands a test one of two workspaces and which one is an accident of its
// position in the run: a POOLED org, baked before the job, which existed at
// boot and went through every boot pass; or a REAL signup, born after boot
// with only what signup and enable give it. Anything a boot pass grants that
// signup does not is a difference between those two, and it fails one run in
// four (#3225, #3246, the afternoon of 2026-09-20) or, on the hosted product,
// a workspace made between two restarts (#3252). The parity test
// (api/tests/a-workspace-born-today-carries-what-a-pooled-one-carries.test.ts)
// reads this shape for one of each and diffs them, so the difference fails
// every run instead.
//
// The shape is deliberately GENERIC: every cobblr_meta table with an org_id
// column, every tenant table's columns and row count, the tenant's triggers
// and its applied migrations. A boot pass that starts writing to a table
// nobody listed here is still in the diff, which is the point; a curated
// list would only ever catch the differences somebody already thought of.
// Rows are normalised so the two workspaces' own identities (ids, the slug,
// the name, times) do not read as differences.
//
// Test-support only: the door that serves it is mounted only under
// COBBLR_TEST_ORG_POOL (see routes/test-support.ts).
import { sql } from "kysely";
import { meta } from "./meta.js";
import { evictTenantPool, getTenantDb } from "./tenant.js";

export interface WorkspaceShape {
  /** cobblr_meta table -> its rows for this org, normalised and sorted. */
  meta: Record<string, string[]>;
  tenant: {
    /** "table.column: type", sorted. */
    columns: string[];
    /** "table: trigger", sorted. */
    triggers: string[];
    /** table -> exact row count. */
    counts: Record<string, number>;
    /** Migration names the tenant DB has applied, sorted. */
    migrations: string[];
  };
}

/** cobblr_meta tables that record HISTORY for a workspace rather than what it
 *  carries. Two workspaces with the same capabilities have different
 *  histories by construction (a pooled org was baked, then booted; a fresh
 *  one was signed up), so these are not shape. Each name states why. */
const META_LEDGERS: Record<string, string> = {
  activity_log: "a ledger of what happened to the workspace; the bake and the boot are events the signup never had",
  notifications: "what was sent to whom, and when",
  warranty_reminder_deliveries: "which warranty reminders reached each person, rather than a workspace capability",
  api_tokens: "minted by tests and people, never by a boot pass",
  test_org_pool: "the pool's own bookkeeping: only the pooled org has a row",
  org_memberships: "who is in the workspace; the pool's owner and the signup's are different people",
  org_invites: "invitations a person sends",
  core_ai_calls: "a ledger of assistant calls",
  feedback: "what people reported",
  scan_inbox_items: "what people scanned",
  sandbox_sessions: "the booth's sessions",
};

/** Columns that are the workspace's own identity or clock, in any table. */
const IDENTITY_COLUMNS = new Set(["id", "org_id", "owner_user_id", "user_id", "created_by", "updated_by", "actor_id"]);
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

export function normaliseValue(v: unknown, self: RegExp | null): unknown {
  if (v === null || v === undefined) return null;
  if (v instanceof Date) return "<time>";
  if (typeof v === "string") {
    let s = v.replace(UUID, "<id>");
    if (self) s = s.replace(self, "<self>");
    return s;
  }
  if (typeof v === "number" || typeof v === "boolean") return v;
  // jsonb: ids and the workspace's own words can sit anywhere inside it.
  return JSON.parse(normaliseValue(JSON.stringify(v), self) as string);
}

export function stableStringify(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(",")}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${stableStringify(o[k])}`)
    .join(",")}}`;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Whole words only: a signup called "parity" must not turn the migration
 *  file 0004_homebox_parity.sql into a difference. A hyphen is a boundary,
 *  so a name derived from the slug (`<slug>-parts`) still reads as the
 *  workspace's own. Longest first, so a name that contains the slug is
 *  replaced as one word. */
export function selfPattern(words: readonly (string | null | undefined)[]): RegExp | null {
  const kept = words
    .filter((w): w is string => typeof w === "string" && w.length >= 3)
    .sort((a, b) => b.length - a.length);
  return kept.length ? new RegExp(`(?<!\\w)(?:${kept.map(escapeRe).join("|")})(?!\\w)`, "g") : null;
}

/** The words that name THIS workspace and its owner, so they read as `<self>`
 *  on both sides of a diff: the slug, the org name, the owner's email and
 *  display name, and the tenant DB name. */
async function selfWords(orgId: string): Promise<RegExp | null> {
  const org = await meta
    .selectFrom("orgs")
    .select(["slug", "name", "db_name"])
    .where("id", "=", orgId)
    .executeTakeFirst();
  if (!org) return null;
  const owners = await meta
    .selectFrom("org_memberships")
    .innerJoin("users", "users.id", "org_memberships.user_id")
    .select(["users.email", "users.display_name"])
    .where("org_memberships.org_id", "=", orgId)
    .execute();
  return selfPattern([org.slug, org.name, org.db_name, ...owners.flatMap((o) => [o.email, o.display_name])]);
}

async function metaShape(orgId: string, self: RegExp | null): Promise<Record<string, string[]>> {
  const tables = await sql<{ table_name: string }>`
    select table_name from information_schema.columns
    where table_schema = 'public' and column_name = 'org_id'
    order by table_name
  `.execute(meta);
  const out: Record<string, string[]> = {};
  // The org's own row is keyed by id, not org_id, and carries settings a
  // boot pass could set; its identity columns are the ones a signup chooses.
  const orgRow = await sql<Record<string, unknown>>`select * from orgs where id = ${orgId}`.execute(meta);
  out.orgs = orgRow.rows.map((r) => {
    const kept: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(r)) {
      // shape_version is a CLOCK like the *_at columns: it counts changes, so
      // two workspaces that carry the same things read different numbers by
      // history alone (one enabled forty modules through signup, one was
      // baked before the counter existed and reads 0). Its only reader asks
      // whether it MOVED, never what it is (platform/workspace-shape.ts).
      if (["id", "slug", "name", "db_name", "db_credentials_encrypted", "shape_version"].includes(k) || k.endsWith("_at")) continue;
      kept[k] = normaliseValue(v, self);
    }
    return stableStringify(kept);
  });
  for (const { table_name } of tables.rows) {
    if (table_name in META_LEDGERS) continue;
    const timeColumns = new Set(
      (
        await sql<{ column_name: string }>`
          select column_name from information_schema.columns
          where table_schema = 'public' and table_name = ${table_name}
            and (data_type like 'timestamp%' or column_name like '%\\_at')
        `.execute(meta)
      ).rows.map((r) => r.column_name),
    );
    const rows = await sql<Record<string, unknown>>`
      select * from ${sql.table(table_name)} where org_id = ${orgId}
    `.execute(meta);
    out[table_name] = rows.rows
      .map((r) => {
        const kept: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(r)) {
          if (IDENTITY_COLUMNS.has(k) || timeColumns.has(k)) continue;
          kept[k] = normaliseValue(v, self);
        }
        return stableStringify(kept);
      })
      .sort();
  }
  return out;
}

async function tenantShape(orgId: string, self: RegExp | null): Promise<WorkspaceShape["tenant"]> {
  const db = await getTenantDb(orgId);
  try {
    const columns = (
      await sql<{ c: string }>`
        select table_name || '.' || column_name || ': ' || data_type as c
        from information_schema.columns where table_schema = 'public'
        order by 1
      `.execute(db)
    ).rows.map((r) => r.c);
    const triggers = (
      await sql<{ t: string }>`
        select distinct event_object_table || ': ' || trigger_name as t
        from information_schema.triggers where trigger_schema = 'public'
        order by 1
      `.execute(db)
    ).rows.map((r) => r.t);
    const tables = (
      await sql<{ table_name: string }>`
        select table_name from information_schema.tables
        where table_schema = 'public' and table_type = 'BASE TABLE'
        order by table_name
      `.execute(db)
    ).rows.map((r) => r.table_name);
    const counts: Record<string, number> = {};
    for (const t of tables) {
      const r = await sql<{ n: string }>`select count(*)::text as n from ${sql.table(t)}`.execute(db);
      counts[t] = Number(r.rows[0]?.n ?? 0);
    }
    // The ledger lives inside the tenant DB (db/migrate.ts), one row per
    // `<scope>::<file>`, so a module migration the boot sync applied and the
    // enable path did not (or the reverse) is a named difference.
    // A row's scope names the tenant by org id or db name; both read as the
    // workspace's own identity.
    const migrations = (
      await sql<{ name: string }>`select name from migrations order by name`.execute(db)
    ).rows.map((r) => normaliseValue(r.name, self) as string);
    return { columns, triggers, counts, migrations };
  } finally {
    // A test-support read never leaves a tenant pool open behind it.
    await evictTenantPool(orgId, { drainMs: 2_000 });
  }
}

export async function workspaceShape(orgId: string): Promise<WorkspaceShape> {
  const self = await selfWords(orgId);
  return { meta: await metaShape(orgId, self), tenant: await tenantShape(orgId, self) };
}
