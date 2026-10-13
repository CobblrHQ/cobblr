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
import { bringAllBack, markAllGone, setCount, unsetCount } from "./reconcile-engine.js";

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
const SCOPE_BATCH = 1000;
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
  const base = () => {
    let q = t
      .selectFrom("inventory_parts")
      .select(["id", "name", "qty", "unit", "image_path", "instance", "created_at", "metadata"])
      .where("archived", "=", false);
    if (!("ids" in scope) && scope.instance) q = q.where("instance", "=", scope.instance);
    return q;
  };
  const tooMany = () => new ActionRefusal(`That is more than ${MAX_SCOPE} records. Take stock one place at a time.`);
  type Row = Awaited<ReturnType<ReturnType<typeof base>["execute"]>>[number];

  let label: string;
  let inScope: Row[];
  if ("ids" in scope) {
    inScope = await base().where("id", "in", scope.ids).orderBy("created_at", "desc").limit(MAX_SCOPE + 1).execute();
    if (inScope.length > MAX_SCOPE) throw tooMany();
    label = `the ${countOf(inScope.length, "thing")} you picked`;
  } else {
    let keep: (path: Array<{ id: string }>) => boolean;
    if ("place_id" in scope) {
      const place = await platform().entities.lookup(orgId, "core-locations:location", scope.place_id);
      if (!place) throw new ActionRefusal("That place no longer exists.");
      label = place.title;
      keep = (path) => path.some((step) => step.id === scope.place_id);
    } else {
      label = "the things with no place";
      keep = (path) => path.length === 0;
    }
    // The cap is on what is in the scope, not on the workspace: the records
    // are read a batch at a time and kept by where they are. Reading the
    // first 2000 of the workspace refused every place in a workspace past
    // 2000, a shelf of two included (the standing walk workspace, 2026-10-11).
    inScope = [];
    let after: string | null = null;
    for (;;) {
      let q = base().orderBy("id").limit(SCOPE_BATCH);
      if (after) q = q.where("id", ">", after);
      const batch = await q.execute();
      if (!batch.length) break;
      const paths = await platform().placement.pathsOf({ orgId, containees: batch.map((r) => ({ kind: PART, id: r.id })) });
      for (const r of batch) if (keep(paths.get(`${PART}:${r.id}`) ?? [])) inScope.push(r);
      if (inScope.length > MAX_SCOPE) throw tooMany();
      if (batch.length < SCOPE_BATCH) break;
      after = batch[batch.length - 1]!.id;
    }
    inScope.sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
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
      // The unit with the amounts: "7.9 left, was 8.4" of a ribbon in metres
      // reads as a count of seven things (#6036).
      counted: JSON.stringify(plan.counted.map((c) => ({ ...ref(c), before: c.before, after: c.after, unit: c.unit }))) as never,
      created_by: userId,
    })
    .returning("id")
    .executeTakeFirstOrThrow();

  // Gone first, all or nothing (the one engine both stocktakes and recounts
  // end through, reconcile-engine.ts): a refusal leaves nothing marked.
  try {
    await markAllGone(orgId, userId, plan.gone.map(ref), `Stocktake of ${plan.label}`);
  } catch (err) {
    await t.deleteFrom("inventory_stocktakes").where("id", "=", row.id).execute();
    throw err;
  }
  for (const c of plan.counted) await setCount(orgId, userId, c, { kind: "stocktake", id: row.id }, "stocktake");
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
  let back: number;
  try {
    back = await bringAllBack(orgId, userId, gone.filter((g) => present.has(g.id)).map((g) => ({ ...g, title: "" })));
  } catch (err) {
    await t.updateTable("inventory_stocktakes").set({ undone_at: null, undone_by: null }).where("id", "=", id).execute();
    throw err;
  }
  for (const c of counted.filter((x) => present.has(x.id))) {
    await unsetCount(orgId, userId, { ...c, title: "" }, { kind: "stocktake", id }, "stocktake undone");
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
  // A stocktake written before the unit was kept with its counts takes the
  // record's own unit, so its history says what the amounts are in too.
  const counted = (row.counted ?? []) as Array<{ id: string; kind: string; title: string; before: number; after: number; unit?: string | null }>;
  const missing = counted.filter((c) => !c.unit).map((c) => c.id);
  const units = missing.length
    ? new Map((await t.selectFrom("inventory_parts").select(["id", "unit"]).where("id", "in", missing).execute()).map((p) => [p.id, p.unit]))
    : new Map<string, string>();
  return {
    id: row.id,
    label: row.scope_label,
    scope: row.scope,
    kept: row.kept,
    gone: row.gone,
    counted: counted.map((c) => ({ ...c, unit: c.unit || units.get(c.id) || "" })),
    created_at: new Date(row.created_at).toISOString(),
    created_by: row.created_by,
    undone_at: row.undone_at ? new Date(row.undone_at).toISOString() : null,
  };
}
