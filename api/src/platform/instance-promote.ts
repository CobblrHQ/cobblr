// Promote a CATEGORY into its own instance — and demote it back.
//
// A workspace's catch-all table accumulates categories (Electrical, Plumbing,
// Fasteners). One of them eventually earns its own table: it has enough items, or
// it wants fields the others don't. That should be a decision you can make LATER,
// after the data exists, and REVERSE if you were wrong — not a schema commitment
// you had to get right before you'd scanned anything.
//
// The schema was already shaped for this and nobody had noticed:
//
//   • `<module>_*.instance` is a plain TEXT column, not an FK. Moving an item
//     between instances is an UPDATE of one string.
//   • inventory_categories was already `unique(instance, slug)`, and its migration
//     comment already anticipated the case: "Same slug can repeat across instances
//     ('bolts' in screws + 'bolts' in electrical)."
//
// So a promote is a RE-STAMP, not a data migration. What actually takes care is
// the surrounding furniture: the field defs (keyed `<instance>:item`), the child
// rows that must travel with their parent, and the presentation/nav rows.
//
// GENERIC BY CONSTRUCTION. Nothing here knows the word "inventory". The tenant
// tables are discovered from the module's `tablePrefix` (exactly as
// tearDownInstance does), and the child rows that must follow their parent are
// discovered from POSTGRES'S OWN FOREIGN KEYS. A module that adds a new
// instance-scoped table gets moved correctly without touching this file.

import { sql } from "kysely";
import { meta } from "../db/meta.js";
import { getEntry } from "../modules/registry.js";
import { getTenantDb } from "../db/tenant.js";
import { createInstance, getInstance, tearDownInstance, type ModuleInstance } from "./instances.js";
import { upsertOverride } from "./entity-kind-overrides.js";
import { singularize, pluralize } from "../lib/inflect.js";
import { normaliseCategory } from "@cobblr/platform-contract/category-reconcile";

/** The value of a custom field lives in the row's `metadata` jsonb blob, so the
 *  category predicate is a jsonb key test — not a column. */
const CATEGORY_KEY = "category";

interface TenantQ {
  executeQuery: (s: unknown) => Promise<{ rows: Array<Record<string, unknown>> }>;
}

/** Every tenant table for this module that is instance-scoped. */
async function instanceScopedTables(tdb: TenantQ, prefix: string): Promise<string[]> {
  const { rows } = await tdb.executeQuery(
    sql`select c.relname as table_name
        from pg_class c
        join pg_namespace n on n.oid = c.relnamespace
        join pg_attribute a on a.attrelid = c.oid
        where n.nspname = 'public'
          and c.relkind = 'r'
          and c.relname like ${prefix + "%"}
          and a.attname = 'instance'
          and a.attnum > 0
          and not a.attisdropped`.compile(tdb as never),
  );
  return rows.map((r) => String(r.table_name));
}

/**
 * Child tables that reference `parent` by a foreign key — asked of POSTGRES, not
 * hardcoded. An allocation must travel with the part it allocates; if it didn't,
 * it would point across an instance boundary at a row that is no longer "here",
 * which is a corrupt state no user could have caused or fixed.
 */
async function childrenOf(
  tdb: TenantQ,
  parent: string,
): Promise<Array<{ table: string; fk: string }>> {
  const { rows } = await tdb.executeQuery(
    sql`select child.relname as table_name, att.attname as fk_col
        from pg_constraint con
        join pg_class child on child.oid = con.conrelid
        join pg_class p on p.oid = con.confrelid
        join pg_attribute att on att.attrelid = con.conrelid and att.attnum = con.conkey[1]
        join pg_attribute pa on pa.attrelid = con.conrelid and pa.attname = 'instance'
        where con.contype = 'f' and p.relname = ${parent}`.compile(tdb as never),
  );
  return rows.map((r) => ({ table: String(r.table_name), fk: String(r.fk_col) }));
}

/** Which of these tables have a `metadata` jsonb column. */
async function tablesWithMetadata(tdb: TenantQ, tables: string[]): Promise<Set<string>> {
  if (tables.length === 0) return new Set();
  const { rows } = await tdb.executeQuery(
    sql`select c.relname as table_name
        from pg_class c
        join pg_namespace n on n.oid = c.relnamespace
        join pg_attribute a on a.attrelid = c.oid
        where n.nspname = 'public'
          and c.relname = any(${tables})
          and a.attname = 'metadata'
          and not a.attisdropped`.compile(tdb as never),
  );
  return new Set(rows.map((r) => String(r.table_name)));
}

/**
 * The module's PRIMARY item table — the one holding the categorised records.
 *
 * The category value lives in the item row's `metadata` jsonb (that's where a
 * custom field's value goes), so the primary table is BY DEFINITION the
 * instance-scoped table that HAS a metadata column. That uniquely picks
 * `inventory_parts` over its siblings — `inventory_categories` and
 * `inventory_allocations` are instance-scoped too but carry no metadata.
 *
 * An earlier version guessed by foreign-key fan-in, which tied (parts→categories
 * and allocations→parts each reference one table) and could pick the wrong,
 * metadata-less table — the `column "metadata" does not exist` crash the
 * round-trip test caught. Among metadata-bearing tables (normally exactly one),
 * FK fan-in is the tiebreak.
 */
async function primaryTable(tdb: TenantQ, tables: string[]): Promise<string | null> {
  const withMeta = await tablesWithMetadata(tdb, tables);
  const candidates = tables.filter((t) => withMeta.has(t));
  if (candidates.length <= 1) return candidates[0] ?? null;
  let best: { table: string; refs: number } | null = null;
  for (const t of candidates) {
    const kids = (await childrenOf(tdb, t)).filter((c) => tables.includes(c.table));
    if (!best || kids.length > best.refs) best = { table: t, refs: kids.length };
  }
  return best?.table ?? null;
}

export interface PromoteResult {
  instance: ModuleInstance;
  moved: number;
}

/**
 * Promote a category out of its parent table into an instance of its own.
 *
 * Items keep their ids, their history, their pairings, their labels — the QR code
 * on the bin still resolves. Only the `instance` string changes.
 */
export async function promoteCategory(args: {
  orgId: string;
  parentInstance: string;
  category: string;
  instanceName: string;
  displayName: string;
}): Promise<PromoteResult> {
  const parent = await getInstance(args.orgId, args.parentInstance);
  if (!parent) throw Object.assign(new Error("parent instance not found"), { code: "instance_not_found" });
  const entry = getEntry(parent.module_name);
  const prefix = entry?.manifest.schema?.tablePrefix;
  if (!prefix) throw Object.assign(new Error("module has no schema"), { code: "no_schema" });

  const instance = await createInstance({
    orgId: args.orgId,
    moduleName: parent.module_name,
    instanceName: args.instanceName,
    displayName: args.displayName,
    isDefault: false,
  });

  // createInstance writes the META db; moveRows writes the TENANT db — two
  // different databases, so there is no single transaction spanning them. If the
  // move fails, the instance we just created would be an ORPHAN (its row exists,
  // no items, and its name is now taken — the exact 409 the round-trip test hit on
  // its second attempt). So on ANY failure past this point, tear the instance back
  // down. moveRows is itself transactional, so a move failure rolled its own work
  // back and tearDownInstance finds nothing half-moved to delete.
  try {
    // The new table needs the parent's FIELD SHAPE, or a promoted item lands in a
    // table that can't display the fields it already carries. Copy the parent's
    // defs across (id regenerated, entity_kind re-keyed) BEFORE moving any rows.
    await copyFieldDefs(args.orgId, kindOf(parent), `${args.instanceName}:item`);

    // Presentation: the nav needs a label + an item noun, exactly as a hand-made
    // instance gets on create.
    const itemNoun = singularize(args.displayName);
    await upsertOverride({
      orgId: args.orgId,
      targetKind: "instance",
      targetId: `${parent.module_name}:${args.instanceName}`,
      displayLabel: args.displayName,
      config: { item_noun: itemNoun, item_noun_plural: pluralize(itemNoun) },
      insertOnly: true,
    });

    const moved = await moveRows(args.orgId, prefix, {
      from: args.parentInstance,
      to: args.instanceName,
      category: args.category,
    });

    return { instance, moved };
  } catch (err) {
    await tearDownInstance(args.orgId, args.instanceName).catch(() => {});
    await deleteInstanceFieldDefs(args.orgId, `${args.instanceName}:item`).catch(() => {});
    throw err;
  }
}

/** Remove the field defs copied onto an instance kind — the compensation for a
 *  promote that failed after copyFieldDefs (tearDownInstance doesn't touch them). */
async function deleteInstanceFieldDefs(orgId: string, kind: string): Promise<void> {
  await meta
    .deleteFrom("module_field_defs")
    .where("org_id", "=", orgId)
    .where("entity_kind", "=", kind)
    .execute();
}

/**
 * Demote an instance back into a category of its parent.
 *
 * The inverse of promote, and it must be a real inverse: promote → demote →
 * promote has to land you where you started. So the items get the category
 * STAMPED on them on the way down (they had it implicitly, by living in the
 * table), and the parent's category field grows the value.
 */
export async function demoteInstance(args: {
  orgId: string;
  instanceName: string;
  parentInstance: string;
  category: string;
}): Promise<{ moved: number }> {
  const inst = await getInstance(args.orgId, args.instanceName);
  if (!inst) throw Object.assign(new Error("instance not found"), { code: "instance_not_found" });
  if (inst.is_default) throw Object.assign(new Error("cannot demote the default instance"), { code: "is_default" });
  const parent = await getInstance(args.orgId, args.parentInstance);
  if (!parent || parent.module_name !== inst.module_name) {
    throw Object.assign(new Error("parent must be an instance of the same module"), { code: "bad_parent" });
  }
  const entry = getEntry(inst.module_name);
  const prefix = entry?.manifest.schema?.tablePrefix;
  if (!prefix) throw Object.assign(new Error("module has no schema"), { code: "no_schema" });

  const moved = await moveRows(args.orgId, prefix, {
    from: args.instanceName,
    to: args.parentInstance,
    // No predicate: EVERYTHING in this instance goes back.
    stampCategory: args.category,
  });

  // The value must exist in the parent's vocabulary, or the demoted items carry a
  // category the table doesn't offer — and the next scan would "propose" it as new.
  await growParentCategory(args.orgId, kindOf(parent), args.category);

  // Now the instance is empty, tear it down (drops its row, its override, its nav
  // membership). tearDownInstance also deletes tenant rows — which is safe
  // precisely BECAUSE we already moved them out.
  await tearDownInstance(args.orgId, args.instanceName);
  return { moved };
}

/** The entity-kind a module instance's field defs are keyed under.
 *
 *  A NAMED instance uses the synthesized `<instance>:item`. The DEFAULT instance
 *  uses the module's real PRIMARY kind — which is NOT `<module>:item`: inventory's
 *  is `inventory:part`. Resolving it from the manifest (not string-building
 *  `<module>:item`) is what makes copyFieldDefs / growParentCategory target the
 *  table that actually exists when the parent is the default/fallback instance. */
function kindOf(inst: ModuleInstance): string {
  if (!inst.is_default) return `${inst.instance_name}:item`;
  const primary = getEntry(inst.module_name)?.manifest.provides?.entityKinds?.find((k) => k.primary);
  return primary?.id ?? `${inst.module_name}:item`;
}

/**
 * Move rows between instances, in ONE transaction.
 *
 * `category` (promote): only rows whose category matches travel.
 * `stampCategory` (demote): every row travels, and gets the category written onto
 * it — it held that identity implicitly by living in the table, and must hold it
 * explicitly once it's back among its siblings.
 *
 * Children follow their parent via Postgres's own foreign keys.
 */
async function moveRows(
  orgId: string,
  prefix: string,
  opts: { from: string; to: string; category?: string; stampCategory?: string },
): Promise<number> {
  const tdb = (await getTenantDb(orgId)) as unknown as TenantQ & {
    transaction: () => { execute: (cb: (trx: TenantQ) => Promise<number>) => Promise<number> };
  };
  const tables = await instanceScopedTables(tdb, prefix);
  const primary = await primaryTable(tdb, tables);
  if (!primary) return 0;
  const children = (await childrenOf(tdb, primary)).filter((c) => tables.includes(c.table));

  return tdb.transaction().execute(async (trx) => {
    // 1. WHICH rows move. On a promote it's the matching category; on a demote
    //    it's everything in the instance.
    const pred = opts.category
      ? sql`instance = ${opts.from} and metadata->>${CATEGORY_KEY} = ${opts.category}`
      : sql`instance = ${opts.from}`;
    const { rows: ids } = await trx.executeQuery(
      sql`select id from ${sql.ref(primary)} where ${pred}`.compile(trx as never),
    );
    const moveIds = ids.map((r) => String(r.id));
    if (moveIds.length === 0) return 0;

    // 2. The parent rows. On a demote, stamp the category as we go so the identity
    //    the table used to carry implicitly survives the move.
    // jsonb_build_object is variadic-"any", so BOTH args need an explicit ::text —
    // without a cast on the key, Postgres can't infer the bound param's type and
    // throws "could not determine data type of parameter". (Promote never hit this:
    // only demote stamps the category.)
    const setCat = opts.stampCategory
      ? sql`, metadata = coalesce(metadata,'{}'::jsonb) || jsonb_build_object(${CATEGORY_KEY}::text, ${opts.stampCategory}::text)`
      : sql``;
    await trx.executeQuery(
      sql`update ${sql.ref(primary)} set instance = ${opts.to} ${setCat} where id = any(${moveIds})`.compile(
        trx as never,
      ),
    );

    // 3. The children, by FK. An allocation that stayed behind would point across
    //    an instance boundary at a row that is no longer there.
    for (const c of children) {
      await trx.executeQuery(
        sql`update ${sql.ref(c.table)} set instance = ${opts.to}
            where ${sql.ref(c.fk)} = any(${moveIds})`.compile(trx as never),
      );
    }
    return moveIds.length;
  });
}

/** Copy a kind's field defs onto another kind — so a promoted table can display
 *  the fields its items already carry. Skips any the target already has. */
async function copyFieldDefs(orgId: string, fromKind: string, toKind: string): Promise<void> {
  const defs = await meta
    .selectFrom("module_field_defs")
    .selectAll()
    .where("org_id", "=", orgId)
    .where("entity_kind", "=", fromKind)
    .execute();
  if (defs.length === 0) return;
  const existing = new Set(
    (
      await meta
        .selectFrom("module_field_defs")
        .select("name")
        .where("org_id", "=", orgId)
        .where("entity_kind", "=", toKind)
        .execute()
    ).map((d) => d.name),
  );
  for (const d of defs) {
    if (existing.has(d.name)) continue;
    // The CATEGORY field does not travel. The promoted table IS one category —
    // an axis there would be a field whose every row holds the same value, and
    // (worse) a second grouping axis the matchmaker would have to disambiguate.
    if (d.field_role === "category") continue;
    await meta
      .insertInto("module_field_defs")
      .values({
        org_id: orgId,
        entity_kind: toKind,
        name: d.name,
        display_label: d.display_label,
        type: d.type,
        required: d.required,
        position: d.position,
        choices: d.choices ? (sql`${JSON.stringify(d.choices)}::jsonb` as never) : null,
        renderer: d.renderer,
        unit: d.unit,
        template: d.template,
        help: d.help,
        decode_role: d.decode_role,
        server_managed: d.server_managed,
        ref_kind: d.ref_kind,
      })
      .onConflict((oc) => oc.doNothing())
      .execute();
  }
}

/** A demoted instance's name must exist in the parent's category vocabulary. */
async function growParentCategory(orgId: string, parentKind: string, value: string): Promise<void> {
  const axis = await meta
    .selectFrom("module_field_defs")
    .selectAll()
    .where("org_id", "=", orgId)
    .where("entity_kind", "=", parentKind)
    .where("field_role", "=", "category")
    .executeTakeFirst();
  if (!axis) return;
  const choices = (axis.choices ?? []) as string[];
  // The SHARED reconciler - see growCategoryChoices; promoting an instance must
  // not seed a duplicate spelling into the parent's vocabulary either.
  const key = normaliseCategory(value);
  if (!key || choices.some((c) => normaliseCategory(c) === key)) return;
  await meta
    .updateTable("module_field_defs")
    .set({ choices: sql`${JSON.stringify([...choices, value].sort((a, b) => a.localeCompare(b)))}::jsonb` as never })
    .where("id", "=", axis.id)
    .execute();
}
