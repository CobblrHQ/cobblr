import { isJunkCategory } from "@cobblr/platform-contract/category-reconcile";
import { platform } from "@cobblr/platform-contract/platform-runtime";
import type { DeletionSnapshot } from "@cobblr/platform-contract/activity-and-events";

// ── Putting a row back exactly as it was ────────────────────────────────────
//
// Undo means the workspace returns to the state it held, not that an opposite
// operation is performed. Those differ where it matters: a delete undone by
// CREATING a lookalike gives the record a new id, so every child location,
// every label and every part that pointed at it now points at nothing. And a
// re-create runs the forward-write rules again, so a restore can be refused by
// a rule the original write predates — undoing a deleted "Shelf 1" fails
// because a "Shelf 1" exists, which is precisely the state being restored.

/** Keep only the columns a table actually has. An image is a RESOLVED record
 *  and may carry computed or joined keys the table would reject. */
export function restorableColumns<T extends string>(
  image: Record<string, unknown>,
  columns: readonly T[],
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const c of columns) if (image[c] !== undefined) out[c] = image[c];
  return out;
}

/** The id an image is for, or null when it carries none — nothing to restore
 *  TO, so the caller recreates and says that is what it did. */
export function imageId(image: Record<string, unknown>): string | null {
  const id = (image as { id?: unknown }).id;
  return typeof id === "string" && id ? id : null;
}

export function registerRowHistoryWriter(kind: string, table: string): void {
  const prefix = `${kind.split(":")[0]!.replace(/-/g, "_")}_`;
  platform().activity.registerHistoryWriter(kind, {
    table,
    snapshotDeletion: async (orgId, id) => snapshotRowTree(await platform().tenants.getDb(orgId), table, id, prefix),
    restoreDeletion: async (orgId, snapshot) => restoreRowTree(await platform().tenants.getDb(orgId), table, snapshot, prefix),
    snapshot: async (orgId, id) => snapshotRow(await platform().tenants.getDb(orgId), table, id),
    restore: async (orgId, image) => restoreRow(await platform().tenants.getDb(orgId), table, image),
  });
}

/** The whole of a module's `snapshot`: every column of one row, by id. */
export async function snapshotRow(
  db: unknown,
  table: string,
  id: string,
): Promise<Record<string, unknown> | null> {
  /* eslint-disable @typescript-eslint/no-explicit-any */
  const q = db as { selectFrom: (t: string) => any };
  /* eslint-enable @typescript-eslint/no-explicit-any */
  const row = await q.selectFrom(table).selectAll().where("id", "=", id).executeTakeFirst();
  return (row as Record<string, unknown> | undefined) ?? null;
}

/** The whole of a writer's `findByKey`: the id of the row whose column, or
 *  `metadata` key, equals `value`, oldest first; null when none. One copy for
 *  every sync target, so a sync adopts a record the same way whichever module
 *  owns it (#3836). The field name is an identifier and is checked as one:
 *  it comes from a sync mapping, which a workspace can author. */
/** A writer's `mergeMetadata`, the same for every module's table: these
 *  keys set (a null removes one), every other key as the live row holds it,
 *  in one statement (`platform().db.mergeJsonb`). */
export async function mergeRowMetadata(db: unknown, table: string, id: string, fields: Record<string, unknown>): Promise<void> {
  if (Object.keys(fields).length === 0) return;
  /* eslint-disable @typescript-eslint/no-explicit-any */
  const q = db as { updateTable: (t: string) => any };
  /* eslint-enable @typescript-eslint/no-explicit-any */
  await q
    .updateTable(table)
    .set({ metadata: platform().db.mergeJsonb("metadata", fields), updated_at: new Date() })
    .where("id", "=", id)
    .execute();
}

/** A writer's `version`: the row's version (`platform().db.rowVersion`). */
export async function rowVersionOf(db: unknown, table: string, id: string): Promise<string | null> {
  /* eslint-disable @typescript-eslint/no-explicit-any */
  const q = db as { selectFrom: (t: string) => any };
  /* eslint-enable @typescript-eslint/no-explicit-any */
  const row = (await q.selectFrom(table).select(platform().db.rowVersion()).where("id", "=", id).executeTakeFirst()) as { row_version?: string } | undefined;
  return row?.row_version ?? null;
}

/** A writer's `updateIf`: the same patch its `update` writes, only while the
 *  row is at `version`, in one statement. The new version, or null when the
 *  row moved on (or is gone) and nothing was written. */
export async function updateRowAt(db: unknown, table: string, id: string, patch: Record<string, unknown>, version: string): Promise<string | null> {
  /* eslint-disable @typescript-eslint/no-explicit-any */
  const q = db as { updateTable: (t: string) => any };
  /* eslint-enable @typescript-eslint/no-explicit-any */
  const row = (await q.updateTable(table).set(patch).where("id", "=", id).where(platform().db.atVersion(version)).returning(platform().db.rowVersion()).executeTakeFirst()) as { row_version?: string } | undefined;
  return row?.row_version ?? null;
}

/** A writer's `adoptAxisValues` for a kind whose category is a native text
 *  field (`categoryField`): the scan placeholder's value under
 *  `metadata[field]` moves into `column` when the record has nothing there
 *  (a value somebody typed stays), then the key is dropped. A placeholder
 *  word ("unknown", "n/a") moves nowhere. Idempotent; `remaining` counts the
 *  records still holding the key, and the platform removes the field at 0. */
export async function adoptAxisValuesIntoField(
  db: unknown,
  table: string,
  args: { field: string; column: string },
): Promise<{ moved: number; remaining: number }> {
  if (!/^[a-z_][a-z0-9_]*$/i.test(args.column) || !/^[a-z_][a-z0-9_]*$/i.test(args.field)) return { moved: 0, remaining: 0 };
  /* eslint-disable @typescript-eslint/no-explicit-any */
  const q = db as { selectFrom: (t: string) => any; updateTable: (t: string) => any };
  /* eslint-enable @typescript-eslint/no-explicit-any */
  const rows = (await q.selectFrom(table).select(["id", args.column, "metadata"]).execute()) as Array<Record<string, unknown>>;
  let moved = 0;
  let remaining = 0;
  for (const row of rows) {
    const meta = (row.metadata ?? {}) as Record<string, unknown>;
    if (!(args.field in meta)) continue;
    const raw = meta[args.field];
    const value = typeof raw === "string" ? raw.trim() : "";
    const current = typeof row[args.column] === "string" ? String(row[args.column]).trim() : "";
    const set: Record<string, unknown> = { metadata: platform().db.mergeJsonb("metadata", { [args.field]: null }) };
    if (!current && value && !isJunkCategory(value)) {
      set[args.column] = value;
      moved++;
    }
    try {
      await q.updateTable(table).set(set).where("id", "=", row.id).execute();
    } catch {
      remaining++;
    }
  }
  return { moved, remaining };
}

export async function findRowIdByKey(
  db: unknown,
  table: string,
  key: { field: string; metadata: boolean },
  value: string,
): Promise<string | null> {
  if (!/^[a-z_][a-z0-9_]*$/i.test(key.field) || !value) return null;
  /* eslint-disable @typescript-eslint/no-explicit-any */
  const q = db as { selectFrom: (t: string) => any };
  let query = q.selectFrom(table).select("id");
  query = key.metadata
    ? query.where((eb: any) => eb(eb.ref("metadata", "->>").key(key.field), "=", value))
    : query.where(key.field, "=", value);
  /* eslint-enable @typescript-eslint/no-explicit-any */
  const row = await query.orderBy("created_at", "asc").limit(1).executeTakeFirst();
  return (row as { id?: string } | undefined)?.id ?? null;
}

/** The whole of a module's `restore`, so four modules do not keep four copies
 *  of it in step — and so a column added by a migration is restored the day it
 *  exists, instead of the day someone remembers to add it to a list here.
 *
 *  Idempotent by id (insert, or overwrite what is there), because a batch undo
 *  that stopped halfway has to be pressable again. */
export async function restoreRow(
  // Structurally a Kysely instance. Typed loosely on purpose: the contract must
  // not take a dependency on any module's generated DB types, and every caller
  // hands it whatever `tenants.getDb` returned.
  db: unknown,
  table: string,
  image: Record<string, unknown>,
): Promise<void> {
  const id = imageId(image);
  if (!id) throw new Error("that change has no record to put back");
  /* eslint-disable @typescript-eslint/no-explicit-any */
  const q = db as { selectFrom: (t: string) => any; insertInto: (t: string) => any };
  /* eslint-enable @typescript-eslint/no-explicit-any */
  const all: Array<{ column_name: string; data_type: string; is_generated: string; identity_generation: string | null }> = (
    await q
      .selectFrom("information_schema.columns")
      .select(["column_name", "data_type", "is_generated", "identity_generation"])
      .where("table_name", "=", table)
      .execute()
  ) as Array<{ column_name: string; data_type: string; is_generated: string; identity_generation: string | null }>;
  if (all.length === 0) throw new Error(`unknown table ${table}`);
  // A column the database computes (a search vector generated from the name,
  // an always-identity) is not part of the state to put back, and Postgres
  // refuses any value for it: restoring a part failed on `search_blob` until
  // these were left to the database.
  const cols = all.filter((c) => c.is_generated !== "ALWAYS" && c.identity_generation !== "ALWAYS");
  const json = new Set(cols.filter((c) => /json/i.test(c.data_type)).map((c) => c.column_name));
  const row: Record<string, unknown> = {};
  for (const c of cols) {
    const v = image[c.column_name];
    if (v === undefined || c.column_name === "id") continue;
    // A jsonb column arrives from an image as a parsed object; hand the driver
    // text and let Postgres cast it, or it stores the string "[object Object]".
    row[c.column_name] = json.has(c.column_name) && v !== null && typeof v === "object" ? JSON.stringify(v) : v;
  }
  await q
    .insertInto(table)
    .values({ ...row, id })
    .onConflict((oc: { column: (c: string) => { doUpdateSet: (r: unknown) => unknown } }) =>
      oc.column("id").doUpdateSet(row),
    )
    .execute();
}

export interface DeletedRowTree {
  rows: Array<{ table: string; row: Record<string, unknown> }>;
  cleared: Array<{ table: string; column: string; row: Record<string, unknown> }>;
}

/** Single-column foreign keys in the public schema that point at `table`
 *  and cascade or clear on delete: the child table and column, the parent
 *  column, and the rule. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function foreignKeysInto(q: any, table: string): Promise<Array<{ table: string; column: string; parentColumn: string; rule: string }>> {
  const parent = await q.selectFrom("pg_catalog.pg_class as p").innerJoin("pg_catalog.pg_namespace as n", "n.oid", "p.relnamespace")
    .select("p.oid").where("n.nspname", "=", "public").where("p.relname", "=", table).executeTakeFirst() as { oid: number } | undefined;
  if (!parent) return [];
  const cons = await q.selectFrom("pg_catalog.pg_constraint as c").innerJoin("pg_catalog.pg_class as child", "child.oid", "c.conrelid")
    .innerJoin("pg_catalog.pg_namespace as cn", "cn.oid", "child.relnamespace")
    .select(["child.relname as table", "c.conrelid", "c.conkey", "c.confkey", "c.confdeltype"])
    .where("c.contype", "=", "f").where("c.confrelid", "=", parent.oid).where("cn.nspname", "=", "public").where("c.confdeltype", "in", ["c", "n"])
    .execute() as Array<{ table: string; conrelid: number; conkey: number[] | string; confkey: number[] | string; confdeltype: string }>;
  const nums = (v: number[] | string) => (Array.isArray(v) ? v : String(v).replace(/[{}]/g, "").split(",").filter(Boolean)).map(Number);
  const single = cons.filter((c) => nums(c.conkey).length === 1 && nums(c.confkey).length === 1);
  if (!single.length) return [];
  const attrs = await q.selectFrom("pg_catalog.pg_attribute").select(["attrelid", "attnum", "attname"])
    .where("attrelid", "in", [...new Set([parent.oid, ...single.map((c) => c.conrelid)])]).where("attnum", ">", 0).execute() as Array<{ attrelid: number; attnum: number; attname: string }>;
  const name = (rel: number, num: number) => attrs.find((a) => Number(a.attrelid) === Number(rel) && Number(a.attnum) === num)?.attname;
  return single.flatMap((c) => {
    const column = name(c.conrelid, nums(c.conkey)[0]!);
    const parentColumn = name(parent.oid, nums(c.confkey)[0]!);
    return column && parentColumn ? [{ table: c.table, column, parentColumn, rule: c.confdeltype === "c" ? "CASCADE" : "SET NULL" }] : [];
  });
}

export async function snapshotRowTree(db: unknown, table: string, id: string, prefix: string): Promise<DeletionSnapshot | null> {
  const image = await snapshotRow(db, table, id);
  if (!image) return null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const q = db as any;
  const related: DeletedRowTree = { rows: [], cleared: [] };
  const seen = new Set<string>();
  // The foreign keys pointing at a table, read once per table per snapshot
  // from pg_catalog. information_schema answered the same in tens of
  // milliseconds a row, more on a loaded box and in a workspace with many
  // tables, and a send or its Undo snapshots every record it touches.
  const keys = new Map<string, Promise<Array<{ table: string; column: string; parentColumn: string; rule: string }>>>();
  const childKeys = (parentTable: string) => {
    let got = keys.get(parentTable);
    if (!got) keys.set(parentTable, (got = foreignKeysInto(q, parentTable)));
    return got;
  };
  const visit = async (parentTable: string, row: Record<string, unknown>): Promise<void> => {
    const key = `${parentTable}:${String(row.id ?? JSON.stringify(row))}`;
    if (seen.has(key)) return;
    seen.add(key);
    if (parentTable !== table || row.id !== id) related.rows.push({ table: parentTable, row });
    const fks = await childKeys(parentTable);
    for (const fk of fks) {
      if (!fk.table.startsWith(prefix) || row[fk.parentColumn] == null) continue;
      const children = await q.selectFrom(fk.table).selectAll().where(fk.column, "=", row[fk.parentColumn]).execute() as Array<Record<string, unknown>>;
      for (const child of children) {
        if (fk.rule === "CASCADE") await visit(fk.table, child);
        else related.cleared.push({ table: fk.table, column: fk.column, row: child });
      }
    }
  };
  await visit(table, image);
  return { image, related };
}

export async function restoreRowTree(db: unknown, table: string, snapshot: DeletionSnapshot, prefix: string): Promise<void> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const q = db as any;
  const related = snapshot.related as DeletedRowTree | undefined;
  const insert = async (t: string, image: Record<string, unknown>) => {
    if (!t.startsWith(prefix)) throw new Error("That saved row belongs to another app.");
    const cols = await q.selectFrom("information_schema.columns").select(["column_name", "data_type", "is_generated", "identity_generation"])
      .where("table_schema", "=", "public").where("table_name", "=", t).execute() as Array<{ column_name: string; data_type: string; is_generated: string; identity_generation: string | null }>;
    const row: Record<string, unknown> = {};
    for (const c of cols) {
      if (c.is_generated === "ALWAYS" || c.identity_generation === "ALWAYS" || image[c.column_name] === undefined) continue;
      const v = image[c.column_name];
      row[c.column_name] = /json/i.test(c.data_type) && v !== null && typeof v === "object" ? JSON.stringify(v) : v;
    }
    await q.insertInto(t).values(row).onConflict((oc: { doNothing(): unknown }) => oc.doNothing()).execute();
  };
  await insert(table, snapshot.image);
  for (const r of related?.rows ?? []) await insert(r.table, r.row);
  for (const r of related?.cleared ?? []) {
    if (!r.table.startsWith(prefix) || !r.row.id) continue;
    await q.updateTable(r.table).set({ [r.column]: r.row[r.column] }).where("id", "=", r.row.id).where(r.column, "is", null).execute();
  }
}

export function canPurgeDeletedRecord(role: string, deletedBy: string | null, userId: string): boolean {
  // role-gate: exact. Permanent removal of someone else's deletion belongs to
  // workspace owners and admins; editors may remove only their own deletions.
  return role === "owner" || role === "admin" || deletedBy === userId;
}
