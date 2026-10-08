import { rebindBackupSecrets } from "./secret-backup.js";
// The part of a backup that lives outside the workspace's own database: its
// rows in the shared platform tables that SHARED_WORKSPACE_TABLES marks
// `backup` (links between records, the workspace's people, field sections,
// menu headings, printed-label tokens, history). See that file for which
// tables and why; this one captures and restores them.
//
// A restore may land in a workspace other than the one the backup came from
// while that one still exists, so every row gets a new id and the old ids are
// swapped for the new ones wherever the workspace's data mentions them (a
// person field, a section an override names), the same way file ids are.

import { randomUUID } from "node:crypto";
import { sql, type Kysely, type Transaction } from "kysely";
import { meta } from "../db/meta.js";
import { BACKUP_TABLES, type BackupTable } from "./workspace-shared-tables.js";

export type PlatformRows = Map<string, Array<Record<string, unknown>>>;

/** Every `backup` table's rows for one workspace. */
export async function capturePlatformRows(orgId: string): Promise<PlatformRows> {
  const out: PlatformRows = new Map();
  const db = meta as unknown as Kysely<unknown>;
  for (const [table] of BACKUP_TABLES) {
    const r = await sql<Record<string, unknown>>`select * from ${sql.table(table)} where org_id = ${orgId}`.execute(db);
    out.set(table, r.rows);
  }
  return out;
}

/** Old id -> new id for every row a restore will re-key. Built before any
 *  write, so the workspace's own rows can be swapped in the same pass as the
 *  file ids. */
export function platformIdMap(rows: PlatformRows): Map<string, string> {
  const map = new Map<string, string>();
  for (const [table, policy] of BACKUP_TABLES) {
    if (!policy.id) continue;
    for (const row of rows.get(table) ?? []) {
      const old = row[policy.id];
      if (typeof old === "string" && !map.has(old)) map.set(old, randomUUID());
    }
  }
  return map;
}

/** Deep-swap any string equal to a key of `map`. Ids are uuids, so value
 *  equality cannot hit an unrelated string. */
export function swapIds(value: unknown, map: Map<string, string>): unknown {
  if (typeof value === "string") return map.get(value) ?? value;
  if (Array.isArray(value)) return value.map((v) => swapIds(v, map));
  if (value && typeof value === "object" && !(value instanceof Date)) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = swapIds(v, map);
    return out;
  }
  return value;
}

interface MetaColumns {
  all: Set<string>;
  jsonb: Set<string>;
  generated: Set<string>;
}
async function metaColumns(db: Kysely<unknown>, table: string): Promise<MetaColumns> {
  const r = await sql<{ column_name: string; data_type: string; is_generated: string }>`
    select column_name, data_type, is_generated from information_schema.columns
    where table_schema = 'public' and table_name = ${table}
  `.execute(db);
  return {
    all: new Set(r.rows.map((c) => c.column_name)),
    jsonb: new Set(r.rows.filter((c) => c.data_type === "jsonb" || c.data_type === "json").map((c) => c.column_name)),
    generated: new Set(r.rows.filter((c) => c.is_generated === "ALWAYS").map((c) => c.column_name)),
  };
}

export interface PlatformRestoreResult {
  rows: number;
  /** Rows the target refused, by table, with the table's stated reason. */
  refused: Array<{ table: string; count: number; why: string }>;
}

/** The row as it should land in `orgId`: its org, a new id, user references
 *  kept only for the target's own members, dropped columns gone. */
export function rowForTarget(
  raw: Record<string, unknown>,
  policy: BackupTable,
  orgId: string,
  ids: Map<string, string>,
  members: Set<string>,
): Record<string, unknown> {
  const row = swapIds(raw, ids) as Record<string, unknown>;
  row.org_id = orgId;
  for (const c of policy.drop ?? []) delete row[c];
  for (const c of policy.users ?? []) {
    const v = row[c];
    if (typeof v === "string" && !members.has(v)) row[c] = null;
  }
  return row;
}

/** Replace the target workspace's rows in every `backup` table with the
 *  backup's. One transaction: all of it lands or none of it does. A row the
 *  target refuses (a printed label another workspace holds, an override of an
 *  action this build lacks) is counted and reported, never fatal, and never
 *  silent. */
export async function restorePlatformRows(
  orgId: string,
  rows: PlatformRows,
  ids: Map<string, string>,
): Promise<PlatformRestoreResult> {
  return (meta as unknown as Kysely<unknown>).transaction().execute(async (trx: Transaction<unknown>) => {
    const members = new Set(
      (await sql<{ user_id: string }>`select user_id from org_memberships where org_id = ${orgId}`.execute(trx)).rows.map(
        (r) => r.user_id,
      ),
    );
    for (const [table] of [...BACKUP_TABLES].reverse()) {
      await sql`delete from ${sql.table(table)} where org_id = ${orgId}`.execute(trx);
    }
    let restored = 0;
    const refused: PlatformRestoreResult["refused"] = [];
    for (const [table, policy] of BACKUP_TABLES) {
      const source = rows.get(table) ?? [];
      if (source.length === 0) continue;
      const cols = await metaColumns(trx, table);
      let refusedHere = 0;
      for (const raw of source) {
        const row = rebindBackupSecrets(orgId, rowForTarget(raw, policy, orgId, ids, members));
        const names = Object.keys(row).filter((c) => cols.all.has(c) && !cols.generated.has(c));
        if (names.length === 0) continue;
        const values = names.map((c) => {
          const v = row[c];
          if (v === null || v === undefined) return sql`null`;
          return cols.jsonb.has(c) ? sql`${JSON.stringify(v)}::jsonb` : sql`${v}`;
        });
        await sql`savepoint backup_row`.execute(trx);
        try {
          const r = await sql`
            insert into ${sql.table(table)} (${sql.join(names.map((c) => sql.ref(c)))})
            values (${sql.join(values)})
            on conflict do nothing
          `.execute(trx);
          await sql`release savepoint backup_row`.execute(trx);
          if (Number(r.numAffectedRows ?? 0n) > 0) restored++;
          else refusedHere++;
        } catch {
          await sql`rollback to savepoint backup_row`.execute(trx);
          refusedHere++;
        }
      }
      if (refusedHere) refused.push({ table, count: refusedHere, why: policy.mayRefuse ?? "the target already holds it" });
    }
    return { rows: restored, refused };
  });
}
