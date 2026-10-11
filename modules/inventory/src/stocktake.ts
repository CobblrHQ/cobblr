// "What's still here?": a stocktake of one place.
//
// A household's records drift: the milk was finished weeks ago and nobody
// tapped it, so the Fridge lists 37 things and holds 6. The person says what
// is left; everything else in that place is marked gone, in one batch, with
// one Undo.
//
// What the 31 are marked with matters more than how. They are `gone`: left by
// today, nobody said how. Not "finished" and not "threw it out", because the
// shelf-life learning (shelf-life-learning.ts) reads those two as evidence of
// how long food keeps, and 31 forgotten items fed in as "threw out today"
// would teach it that milk keeps 40 days. A stocktake goes through the
// disposition door (platform().dispositions), which archives the record and
// never touches the learning.
//
// A count ("half the cheddar") keeps the record and lowers its quantity
// through the same stock door every other count uses, as a correction: it is
// what is there, not a use.
import type { Kysely } from "kysely";
import { ActionRefusal, platform } from "@cobblr/platform-contract";
import { countOf } from "@cobblr/platform-contract/plural";
import type { InventoryDB } from "./db.js";
import { consumeOldest } from "./batches.js";
import { withBatches } from "./api/action-handlers.js";

/** Where the stocktake looks: a place (and everything inside it, a shelf in
 *  the Fridge included), everything of a collection that has no place, or the
 *  records a person picked in a table. */
export type StocktakeScope = { place_id: string; instance?: string | null } | { unplaced: true; instance: string } | { ids: string[] };

export interface StocktakeItem {
  id: string;
  kind: string;
  title: string;
  qty: number;
  unit: string;
  image_path: string | null;
  /** What a scanner reads off it, so a scan in the sheet ticks this row. */
  barcode: string | null;
  created_at: string;
}

export interface StocktakePlan {
  label: string;
  kept: StocktakeItem[];
  gone: StocktakeItem[];
  counted: Array<StocktakeItem & { before: number; after: number }>;
  /** Set when the run needs the person to say the number back first: every
   *  record of a collection with no place, or every record in scope going. */
  confirm: { count: number; sentence: string } | null;
}

const PART = "inventory:part";
const MAX_SCOPE = 2000;
const kindOf = (instance: string) => (instance === "inventory" ? PART : `${instance}:item`);
const db = async (orgId: string) => (await platform().tenants.getDb(orgId)) as Kysely<InventoryDB>;

function parseScope(raw: unknown): StocktakeScope {
  const s = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const instance = typeof s.instance === "string" && s.instance.trim() ? s.instance.trim() : null;
  if (typeof s.place_id === "string" && s.place_id) return { place_id: s.place_id, instance };
  if (s.unplaced === true) {
    if (!instance) throw new ActionRefusal("Say which collection to look through for things with no place (instance).");
    return { unplaced: true, instance };
  }
  if (Array.isArray(s.ids)) {
    const ids = [...new Set(s.ids.filter((v): v is string => typeof v === "string" && !!v))];
    if (ids.length) return { ids };
  }
  throw new ActionRefusal("Choose where to take stock: a place (place_id), a collection's things with no place (unplaced and instance), or the records you picked (ids).");
}

/** Everything still listed in the scope, newest first, and what to call it. */
export async function scopeOf(orgId: string, rawScope: unknown): Promise<{ scope: StocktakeScope; label: string; items: StocktakeItem[] }> {
  const scope = parseScope(rawScope);
  const t = await db(orgId);
  let q = t
    .selectFrom("inventory_parts")
    .select(["id", "name", "qty", "unit", "image_path", "instance", "created_at", "metadata"])
    .where("archived", "=", false)
    .orderBy("created_at", "desc")
    .limit(MAX_SCOPE + 1);
  if ("ids" in scope) q = q.where("id", "in", scope.ids);
  else if (scope.instance) q = q.where("instance", "=", scope.instance);
  const rows = await q.execute();
  if (rows.length > MAX_SCOPE) throw new ActionRefusal(`That is more than ${MAX_SCOPE} records. Take stock one place at a time.`);

  let label: string;
  let inScope = rows;
  if ("ids" in scope) {
    label = `the ${countOf(rows.length, "thing")} you picked`;
  } else {
    const paths = await platform().placement.pathsOf({ orgId, containees: rows.map((r) => ({ kind: PART, id: r.id })) });
    const pathOf = (id: string) => paths.get(`${PART}:${id}`) ?? [];
    if ("place_id" in scope) {
      const place = await platform().entities.lookup(orgId, "core-locations:location", scope.place_id);
      if (!place) throw new ActionRefusal("That place no longer exists.");
      label = place.title;
      inScope = rows.filter((r) => pathOf(r.id).some((step) => step.id === scope.place_id));
    } else {
      label = "the things with no place";
      inScope = rows.filter((r) => pathOf(r.id).length === 0);
    }
  }
  return {
    scope,
    label,
    items: inScope.map((r) => ({
      id: r.id,
      kind: kindOf(r.instance),
      title: r.name,
      qty: Number(r.qty),
      unit: r.unit,
      image_path: r.image_path,
      barcode: barcodeOf(r.metadata),
      created_at: new Date(r.created_at).toISOString(),
    })),
  };
}

/** The code a scanner reads off a record: its barcode, else its UPC or EAN. */
function barcodeOf(metadata: unknown): string | null {
  const m = (metadata && typeof metadata === "object" ? metadata : {}) as Record<string, unknown>;
  for (const key of ["barcode", "upc", "ean"]) {
    const v = m[key];
    if (typeof v === "string" && v.trim()) return v.trim();
    if (typeof v === "number" && Number.isFinite(v)) return String(v);
  }
  return null;
}

export interface StocktakeInput {
  scope: unknown;
  keep?: unknown;
  counted?: unknown;
  confirm_count?: unknown;
}

const idList = (v: unknown): string[] => (Array.isArray(v) ? [...new Set(v.filter((x): x is string => typeof x === "string" && !!x))] : []);

/** What a run would do, without doing it: the card's preview and the
 *  handler's first step, so the two can never disagree. */
export async function planStocktake(orgId: string, input: StocktakeInput): Promise<StocktakePlan & { scope: StocktakeScope }> {
  const { scope, label, items } = await scopeOf(orgId, input.scope);
  const byId = new Map(items.map((i) => [i.id, i]));
  const keep = new Set(idList(input.keep));
  const counts = new Map<string, number>();
  for (const c of Array.isArray(input.counted) ? input.counted : []) {
    const r = (c ?? {}) as { id?: unknown; qty?: unknown };
    const qty = typeof r.qty === "number" ? r.qty : Number(r.qty);
    if (typeof r.id !== "string" || !Number.isFinite(qty) || qty < 0) throw new ActionRefusal("Each count needs a record id and how many are left (0 or more).");
    counts.set(r.id, qty);
  }
  const outside = [...keep, ...counts.keys()].filter((id) => !byId.has(id));
  if (outside.length) {
    throw new ActionRefusal(`${countOf(outside.length, "record")} you named ${outside.length === 1 ? "is" : "are"} not listed in ${label}. Take stock of what is there, and add anything new as its own item first.`);
  }

  const kept: StocktakeItem[] = [];
  const gone: StocktakeItem[] = [];
  const counted: StocktakePlan["counted"] = [];
  for (const item of items) {
    const n = counts.get(item.id);
    if (n !== undefined) {
      if (n === 0) gone.push(item);
      else if (n >= item.qty) kept.push(item);
      else counted.push({ ...item, before: item.qty, after: n });
    } else if (keep.has(item.id)) kept.push(item);
    else gone.push(item);
  }

  let confirm: StocktakePlan["confirm"] = null;
  if (gone.length && "unplaced" in scope) {
    confirm = { count: gone.length, sentence: `This marks ${countOf(gone.length, "thing")} with no place gone.` };
  } else if (gone.length && gone.length === items.length) {
    confirm = { count: gone.length, sentence: `Nothing is left in ${label}: this marks all ${countOf(gone.length, "thing")} there gone.` };
  }
  return { scope, label, kept, gone, counted, confirm };
}

export interface StocktakeDone {
  id: string;
  label: string;
  kept: number;
  gone: number;
  counted: number;
}

const ref = (i: StocktakeItem) => ({ id: i.id, kind: i.kind, title: i.title });

function byKind<T extends { id: string; kind: string }>(items: readonly T[]): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const i of items) out.set(i.kind, [...(out.get(i.kind) ?? []), i.id]);
  return out;
}

/** Take stock: mark the rest gone, set the counts, and keep one row that the
 *  activity line and Undo both read. */
export async function runStocktake(orgId: string, userId: string | null, input: StocktakeInput): Promise<StocktakeDone> {
  const plan = await planStocktake(orgId, input);
  if (plan.confirm && Number(input.confirm_count) !== plan.confirm.count) {
    throw new ActionRefusal(`${plan.confirm.sentence} Say the number back (confirm_count: ${plan.confirm.count}) to go ahead.`);
  }
  if (!plan.gone.length && !plan.counted.length) throw new ActionRefusal(`Everything in ${plan.label} is still there. Nothing to change.`);
  const t = await db(orgId);
  const row = await t
    .insertInto("inventory_stocktakes")
    .values({
      scope: plan.scope,
      scope_label: plan.label,
      kept: JSON.stringify(plan.kept.map(ref)) as never,
      gone: JSON.stringify(plan.gone.map(ref)) as never,
      counted: JSON.stringify(plan.counted.map((c) => ({ ...ref(c), before: c.before, after: c.after }))) as never,
      created_by: userId,
    })
    .returning("id")
    .executeTakeFirstOrThrow();

  // Gone first: the door refuses a whole batch before writing any of it, so a
  // refusal here leaves nothing to put back but what an earlier kind marked.
  const marked: Array<[string, string[]]> = [];
  for (const [kind, ids] of byKind(plan.gone)) {
    const r = await platform().dispositions.markGone(orgId, userId, kind, ids, { how: "gone", note: `Stocktake of ${plan.label}` }, { quiet: true });
    if (!r.ok) {
      for (const [k, done] of marked) await platform().dispositions.bringBack(orgId, userId, k, done, { quiet: true });
      await t.deleteFrom("inventory_stocktakes").where("id", "=", row.id).execute();
      throw new ActionRefusal(r.error);
    }
    marked.push([kind, ids]);
  }
  for (const c of plan.counted) {
    await withBatches(orgId, c.id, "stocktake", c.after - c.before, (batches) => consumeOldest(batches, c.before - c.after).batches, {
      userId,
      correction: true,
      sourceKind: "stocktake",
      sourceId: row.id,
    });
  }
  await platform().activity.log({
    orgId,
    userId,
    action: "stocktake_taken",
    ref: { module: "inventory", entityType: "stocktake", entityId: row.id },
    diff: { name: plan.label, kept: plan.kept.length + plan.counted.length, gone: plan.gone.length, counted: plan.counted.length },
  });
  return { id: row.id, label: plan.label, kept: plan.kept.length + plan.counted.length, gone: plan.gone.length, counted: plan.counted.length };
}

/** Put a stocktake back: every record it marked gone listed again, every count
 *  it lowered raised by what it took. Records deleted since are left alone. */
export async function undoStocktake(orgId: string, userId: string | null, id: string): Promise<{ label: string; back: number }> {
  const t = await db(orgId);
  const row = await t.selectFrom("inventory_stocktakes").selectAll().where("id", "=", id).executeTakeFirst();
  if (!row) throw new ActionRefusal("That stocktake no longer exists.");
  if (row.undone_at) throw new ActionRefusal(`The stocktake of ${row.scope_label} is already undone.`);
  const claimed = await t
    .updateTable("inventory_stocktakes")
    .set({ undone_at: new Date(), undone_by: userId })
    .where("id", "=", id)
    .where("undone_at", "is", null)
    .executeTakeFirst();
  if (!Number(claimed.numUpdatedRows)) throw new ActionRefusal(`The stocktake of ${row.scope_label} is already undone.`);

  const gone = row.gone as unknown as Array<{ id: string; kind: string }>;
  const counted = row.counted as unknown as Array<{ id: string; before: number; after: number }>;
  const ids = [...gone.map((g) => g.id), ...counted.map((c) => c.id)];
  const present = new Set(ids.length ? (await t.selectFrom("inventory_parts").select("id").where("id", "in", ids).execute()).map((r) => r.id) : []);
  let back = 0;
  for (const [kind, kindIds] of byKind(gone.filter((g) => present.has(g.id)))) {
    const r = await platform().dispositions.bringBack(orgId, userId, kind, kindIds, { quiet: true });
    if (!r.ok) {
      await t.updateTable("inventory_stocktakes").set({ undone_at: null, undone_by: null }).where("id", "=", id).execute();
      throw new ActionRefusal(r.error);
    }
    back += r.done.length;
  }
  for (const c of counted.filter((x) => present.has(x.id))) {
    await withBatches(orgId, c.id, "stocktake undone", c.before - c.after, (batches) => batches, { userId, correction: true, sourceKind: "stocktake", sourceId: id });
    back += 1;
  }
  await platform().activity.log({
    orgId,
    userId,
    action: "stocktake_undone",
    ref: { module: "inventory", entityType: "stocktake", entityId: id },
    diff: { name: row.scope_label, back },
  });
  return { label: row.scope_label, back };
}

/** One stocktake as its page reads it. */
export async function readStocktake(orgId: string, id: string) {
  const t = await db(orgId);
  const row = await t.selectFrom("inventory_stocktakes").selectAll().where("id", "=", id).executeTakeFirst();
  if (!row) return null;
  return {
    id: row.id,
    label: row.scope_label,
    scope: row.scope,
    kept: row.kept,
    gone: row.gone,
    counted: row.counted,
    created_at: new Date(row.created_at).toISOString(),
    created_by: row.created_by,
    undone_at: row.undone_at ? new Date(row.undone_at).toISOString() : null,
  };
}
