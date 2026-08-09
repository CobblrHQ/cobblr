// Move records between instances of one module.
//
// The row never moves and its uuid never changes: a module flips one column
// (inventory's `instance`) and the record's kind string follows, because the
// kind IS a function of that column. Everything below is about the references
// that stored the old kind beside the id. See instance-move.ts for the list and
// docs/design-decisions/move-between-instances.md for why this is not the
// cross-module migration the substrate doc forbids.

import { sql, type Kysely } from "kysely";
import { meta } from "../db/meta.js";
import { getTenantDb } from "../db/tenant.js";
import { SATELLITE_TABLES, type SatelliteRef } from "./instance-move.js";
import { getInstance } from "./instances.js";

const movers = new Map<string, InstanceMover>();

export interface InstanceMover {
  /** Flip the instance column for these ids. MUST be a plain update: never
   *  insert, never delete, never mint an id. Returns the ids actually moved,
   *  so the platform rewrites references for exactly those and no others. */
  move(orgId: string, ids: string[], from: string, to: string, db: unknown): Promise<string[]>;
  /** The kind string this module's records answer to in a given instance.
   *  Only the module knows its own default-instance rule (inventory's default
   *  is `inventory:part`, every named one is `<instance>:item`). */
  kindFor(instance: string): string;
  /** Each record's custom-field bag, for the preview's carry list. */
  metadataFor(orgId: string, ids: string[]): Promise<Array<Record<string, unknown>>>;
}

export function registerMover(moduleName: string, mover: InstanceMover): void {
  movers.set(moduleName, mover);
}

export function getMover(moduleName: string): InstanceMover | undefined {
  return movers.get(moduleName);
}

export interface MovePlan {
  moduleName: string;
  from: string;
  to: string;
  fromKind: string;
  toKind: string;
  ids: string[];
  /** Custom-field values that would render unlabeled in the target, because
   *  the target kind has no def for them. Carried unless the caller opts out. */
  fieldsToCarry: Array<{ name: string; display_label: string; type: string; count: number }>;
}

export interface MoveResult {
  moved: string[];
  fieldsCarried: string[];
  satellitesRewritten: number;
}

class MoveError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
  }
}

/** Same module, both instances real, and actually different. A cross-module
 *  target is refused by name rather than coerced: that move is a different and
 *  far more expensive operation, and pretending otherwise is how a fake
 *  migration gets built. */
async function validate(orgId: string, moduleName: string, from: string, to: string) {
  if (from === to) throw new MoveError("Source and target are the same instance.", "same_instance");
  const [a, b] = await Promise.all([getInstance(orgId, from), getInstance(orgId, to)]);
  if (!a) throw new MoveError(`No instance "${from}" in this workspace.`, "unknown_instance");
  if (!b) throw new MoveError(`No instance "${to}" in this workspace.`, "unknown_instance");
  if (a.module_name !== b.module_name) {
    throw new MoveError(
      `"${from}" belongs to ${a.module_name} and "${to}" to ${b.module_name}. ` +
        `Moving a record between MODULES is a different operation and is not supported.`,
      "cross_module",
    );
  }
  if (a.module_name !== moduleName) {
    throw new MoveError(`"${from}" does not belong to ${moduleName}.`, "wrong_module");
  }
}

/** Which of the moved records' custom-field values would lose their label.
 *  Values live in the row's `metadata` and travel for free; a def keyed to the
 *  old kind does not, so without this they render unlabeled and it reads as
 *  data loss even though nothing was lost. */
async function fieldCarryPlan(
  orgId: string,
  fromKind: string,
  toKind: string,
  metadatas: Array<Record<string, unknown>>,
): Promise<MovePlan["fieldsToCarry"]> {
  const [sourceDefs, targetDefs] = await Promise.all([
    meta
      .selectFrom("module_field_defs")
      .select(["name", "display_label", "type"])
      .where("org_id", "=", orgId)
      .where("entity_kind", "=", fromKind)
      .execute(),
    meta
      .selectFrom("module_field_defs")
      .select(["name"])
      .where("org_id", "=", orgId)
      .where("entity_kind", "=", toKind)
      .execute(),
  ]);
  const already = new Set(targetDefs.map((d) => d.name));
  const plan: MovePlan["fieldsToCarry"] = [];
  for (const def of sourceDefs) {
    if (already.has(def.name)) continue;
    // Only fields the moved records ACTUALLY use. Carrying every def would
    // reshape the destination for the whole workspace on the strength of one
    // record's move.
    const count = metadatas.filter(
      (m) => m[def.name] !== undefined && m[def.name] !== null && m[def.name] !== "",
    ).length;
    if (count > 0) plan.push({ ...def, count });
  }
  return plan;
}

/** Rewrite one reference table. Scoped by the record ids (which never change)
 *  AND filtered on the OLD kind, which makes a re-run after a crash between the
 *  two transactions a no-op rather than a double-apply, and stops it touching a
 *  row that merely shares a uuid. Table and column names come from the frozen
 *  descriptor list, never from user input. */
async function rewrite(
  db: Kysely<never>,
  ref: SatelliteRef,
  fromKind: string,
  toKind: string,
  ids: string[],
): Promise<number> {
  const [fromModule, fromType] = fromKind.split(":");
  const [toModule, toType] = toKind.split(":");
  const t = sql.table(ref.table);
  const idCol = sql.ref(ref.idCol);
  const kindCol = sql.ref(ref.kindCol);
  // The id columns are a mix of uuid and text across these tables, so compare
  // as text and let Postgres cast once rather than guessing per table.
  const idList = sql.join(ids.map((i) => sql`${i}`));

  const res = ref.splitKind
    ? await sql`
        update ${t}
           set ${kindCol} = ${toType}, ${sql.ref(ref.moduleCol!)} = ${toModule}
         where ${idCol}::text in (${idList})
           and ${kindCol} = ${fromType}
           and ${sql.ref(ref.moduleCol!)} = ${fromModule}
      `.execute(db)
    : ref.moduleCol
      ? await sql`
          update ${t}
             set ${kindCol} = ${toType}, ${sql.ref(ref.moduleCol)} = ${toModule}
           where ${idCol}::text in (${idList})
             and ${kindCol} = ${fromType}
        `.execute(db)
      : await sql`
          update ${t}
             set ${kindCol} = ${toKind}
           where ${idCol}::text in (${idList})
             and ${kindCol} = ${fromKind}
        `.execute(db);
  return Number(res.numAffectedRows ?? 0);
}

/** Which of a set of tables actually exist here. Modules are OPT-IN, so a
 *  workspace that never enabled `labels` has no `labels_codes`, and rewriting
 *  it fails the whole move with `relation "labels_codes" does not exist`. That
 *  is not hypothetical: the integration test missed it because its workspace
 *  enables every module, and the first run against a REAL workspace (inventory
 *  only) hit it immediately. One cheap lookup per database beats a per-table
 *  guard, and keeps the affected-row counts. */
async function existingTables(db: Kysely<never>, names: string[]): Promise<Set<string>> {
  const rows = await sql<{ table_name: string }>`
    select table_name from information_schema.tables
     where table_schema = 'public' and table_name in (${sql.join(names.map((n) => sql`${n}`))})
  `.execute(db);
  return new Set(rows.rows.map((r) => r.table_name));
}

/** Build the preview: what would move, and what the user is agreeing to. */
export async function planMove(
  orgId: string,
  moduleName: string,
  ids: string[],
  from: string,
  to: string,
  metadatas: Array<Record<string, unknown>>,
): Promise<MovePlan> {
  await validate(orgId, moduleName, from, to);
  const mover = movers.get(moduleName);
  if (!mover) throw new MoveError(`${moduleName} does not support moving records.`, "no_mover");
  const fromKind = mover.kindFor(from);
  const toKind = mover.kindFor(to);
  return {
    moduleName,
    from,
    to,
    fromKind,
    toKind,
    ids,
    fieldsToCarry: await fieldCarryPlan(orgId, fromKind, toKind, metadatas),
  };
}

/**
 * Run the move. TWO transactions, not one: the references span two databases
 * (tags and files are tenant-side, QR tokens and activity are in cobblr_meta)
 * and this platform has no distributed transaction. So:
 *
 *   1. tenant tx: the module's column flip + every tenant-side rewrite, atomic.
 *      A failure here rolls back to "nothing happened".
 *   2. meta tx: the meta-side rewrites + the field defs.
 *
 * A crash between them leaves records in the new instance with meta references
 * still on the old kind. Every rewrite filters on the old kind, so re-issuing
 * the same move completes it instead of erroring or double-applying. That is
 * the case the crash-window test exercises.
 */
export async function moveRecords(
  orgId: string,
  moduleName: string,
  ids: string[],
  from: string,
  to: string,
  opts: { carryFields?: string[] } = {},
): Promise<MoveResult> {
  await validate(orgId, moduleName, from, to);
  const mover = movers.get(moduleName);
  if (!mover) throw new MoveError(`${moduleName} does not support moving records.`, "no_mover");
  if (ids.length === 0) return { moved: [], fieldsCarried: [], satellitesRewritten: 0 };

  const fromKind = mover.kindFor(from);
  const toKind = mover.kindFor(to);
  const tenantDb = await getTenantDb(orgId);

  let moved: string[] = [];
  let rewritten = 0;

  // ── 1. tenant ────────────────────────────────────────────────────────────
  await tenantDb.transaction().execute(async (trx) => {
    // The module writes through OUR transaction handle, not its own pool
    // connection, or its update would sit outside this transaction.
    moved = await mover.move(orgId, ids, from, to, trx);
    if (moved.length === 0) return;
    const t = trx as unknown as Kysely<never>;
    const tenantRefs = SATELLITE_TABLES.filter((r) => r.db === "tenant");
    const present = await existingTables(t, [...new Set(tenantRefs.map((r) => r.table))]);
    for (const ref of tenantRefs) {
      if (!present.has(ref.table)) continue; // module not enabled here
      rewritten += await rewrite(t, ref, fromKind, toKind, moved);
    }
  });

  if (moved.length === 0) return { moved: [], fieldsCarried: [], satellitesRewritten: 0 };

  // ── 2. meta ──────────────────────────────────────────────────────────────
  const carried: string[] = [];
  await meta.transaction().execute(async (trx) => {
    const m = trx as unknown as Kysely<never>;
    const metaRefs = SATELLITE_TABLES.filter((r) => r.db === "meta");
    const presentMeta = await existingTables(m, [...new Set(metaRefs.map((r) => r.table))]);
    for (const ref of metaRefs) {
      if (!presentMeta.has(ref.table)) continue;
      rewritten += await rewrite(m, ref, fromKind, toKind, moved);
    }
    if (opts.carryFields?.length) {
      const defs = await trx
        .selectFrom("module_field_defs")
        .selectAll()
        .where("org_id", "=", orgId)
        .where("entity_kind", "=", fromKind)
        .where("name", "in", opts.carryFields)
        .execute();
      for (const d of defs) {
        // onConflict: a concurrent move of a sibling record may have created
        // the same def a moment ago. Both callers wanted it; one wins quietly.
        await trx
          .insertInto("module_field_defs")
          .values({
            org_id: orgId,
            entity_kind: toKind,
            name: d.name,
            display_label: d.display_label,
            type: d.type,
            required: false,
            position: d.position,
            bundle_id: null,
          })
          .onConflict((c) => c.columns(["org_id", "entity_kind", "name"]).doNothing())
          .execute();
        carried.push(d.name);
      }
    }
  });

  return { moved, fieldsCarried: carried, satellitesRewritten: rewritten };
}

export { MoveError };
