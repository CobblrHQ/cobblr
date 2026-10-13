// Recount a collection (#6302): every record of a collection, or of one
// category in it, across every place, scanned again. The owner: "I want to
// rescan all my filament from scratch ... not every filament has a barcode on
// it."
//
// A recount is a session that stays open for days ("143 of 210 seen"). Each
// scan is matched to one expected record (recount-match.ts) or noted as
// something new, with where it is now and how much is left. Nothing on the
// records changes while it is open: the reconcile at the end is previewed
// and applied in one step, with one Undo, the way "What's still here?" is.
import { sql, type Kysely } from "kysely";
import { ActionRefusal, placeLine, platform } from "@cobblr/platform-contract";
import { countOf } from "@cobblr/platform-contract/plural";
import type { InventoryDB } from "./db.js";
import { matchScan, type RecountItem, type RecountMatch, type RecountScanInput } from "./recount-match.js";
import { familiesOf, type Family } from "./api/families.js";

/** A collection, or one category of it, wherever its things are. */
export interface RecountScope {
  collection: string;
  category_id?: string | null;
}

const PART = "inventory:part";
const MAX_EXPECTED = 2000;
const PATHS_BATCH = 1000;
/** Metadata that is about the record, not the thing: never an attribute a
 *  label could state. */
const NOT_ATTRIBUTES = new Set(["barcode", "upc", "ean", "scan_source", "tracked_match"]);
const kindOf = (instance: string) => (instance === "inventory" ? PART : `${instance}:item`);
const db = async (orgId: string) => (await platform().tenants.getDb(orgId)) as Kysely<InventoryDB>;

function barcodeOf(metadata: Record<string, unknown>): string | null {
  for (const key of ["barcode", "upc", "ean"]) {
    const v = metadata[key];
    if (typeof v === "string" && v.trim()) return v.trim();
    if (typeof v === "number" && Number.isFinite(v)) return String(v);
  }
  return null;
}

function attributesOf(metadata: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(metadata)) {
    if (NOT_ATTRIBUTES.has(k) || k.startsWith("_") || /_(at|id)$/.test(k)) continue;
    if (typeof v === "string" && v.trim() && v.length <= 120) out[k] = v.trim();
    else if (typeof v === "number" && Number.isFinite(v)) out[k] = String(v);
  }
  return out;
}

/** The collection a person names, by its name or its label, case aside. */
async function collectionOf(orgId: string, raw: unknown): Promise<{ instance: string; label: string }> {
  const said = typeof raw === "string" ? raw.trim() : "";
  const lists = (await platform().instances.list(orgId)).filter((i) => i.module_name === "inventory");
  if (!said) throw new ActionRefusal("Say which collection to recount.");
  const n = (v: string) => v.trim().toLowerCase();
  const hit = lists.find((i) => n(i.instance_name) === n(said) || n(i.display_name) === n(said)) ?? (n(said) === "inventory" ? { instance_name: "inventory", display_name: "Inventory" } : null);
  if (!hit) {
    const have = lists.map((i) => i.display_name).join(", ");
    throw new ActionRefusal(`There is no collection called "${said}". The ones here are: ${have || "Inventory"}.`);
  }
  return { instance: hit.instance_name, label: hit.display_name };
}

export async function parseRecountScope(orgId: string, raw: unknown): Promise<{ scope: RecountScope; label: string }> {
  const s = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const { instance, label } = await collectionOf(orgId, s.collection);
  const category = typeof s.category_id === "string" && s.category_id ? s.category_id : null;
  if (!category) return { scope: { collection: instance }, label };
  const t = await db(orgId);
  const row = await t.selectFrom("inventory_categories").select(["name"]).where("id", "=", category).executeTakeFirst();
  if (!row) throw new ActionRefusal("That category no longer exists.");
  return { scope: { collection: instance, category_id: category }, label: `${label} · ${row.name}` };
}

/** Everything the recount expects to see: every record still listed in the
 *  scope, wherever it is, oldest first (the order a shelf was filled in). */
export async function expectedOf(orgId: string, scope: RecountScope): Promise<RecountItem[]> {
  const t = await db(orgId);
  let q = t
    .selectFrom("inventory_parts")
    .select(["id", "name", "qty", "unit", "image_path", "instance", "created_at", "metadata", "manufacturer"])
    .where("archived", "=", false)
    .where("instance", "=", scope.collection);
  if (scope.category_id) q = q.where("category_id", "=", scope.category_id);
  const rows = await q.orderBy("created_at").orderBy("id").limit(MAX_EXPECTED + 1).execute();
  if (rows.length > MAX_EXPECTED) throw new ActionRefusal(`That is more than ${MAX_EXPECTED} records. Recount one category at a time.`);
  const places = new Map<string, string>();
  for (let i = 0; i < rows.length; i += PATHS_BATCH) {
    const batch = rows.slice(i, i + PATHS_BATCH);
    const paths = await platform().placement.pathsOf({ orgId, containees: batch.map((r) => ({ kind: PART, id: r.id })) });
    for (const r of batch) {
      const path = paths.get(`${PART}:${r.id}`) ?? [];
      if (path.length) places.set(r.id, placeLine(path));
    }
  }
  return rows.map((r) => {
    const meta = (r.metadata ?? {}) as Record<string, unknown>;
    return {
      id: r.id,
      kind: kindOf(r.instance),
      title: r.name,
      qty: Number(r.qty),
      unit: r.unit,
      image_path: r.image_path,
      barcode: barcodeOf(meta),
      manufacturer: r.manufacturer,
      attributes: attributesOf(meta),
      place: places.get(r.id) ?? null,
      created_at: new Date(r.created_at).toISOString(),
    };
  });
}

export interface RecountRead {
  id: string;
  label: string;
  scope: RecountScope;
  status: string;
  created_at: string;
  /** What finishing it changed, once it is finished (its Undo reads the same). */
  applied: import("./recount-reconcile.js").RecountApplied | null;
  /** Every expected record, and the scan that counted it if one has. */
  expected: Array<RecountItem & { seen: { scan_id: string; by: string; place_id: string | null; amount: number | null } | null }>;
  /** Things scanned that are on no record yet. */
  new: Array<{ scan_id: string; title: string; like_id: string | null; like_type_id: string | null; barcode: string | null; place_id: string | null; amount: number | null }>;
  progress: { seen: number; expected: number; new: number };
}

export async function readRecount(orgId: string, id: string): Promise<RecountRead | null> {
  const t = await db(orgId);
  const row = await t.selectFrom("inventory_recounts").selectAll().where("id", "=", id).executeTakeFirst();
  if (!row) return null;
  const expected = await expectedOf(orgId, row.scope);
  const scans = await t.selectFrom("inventory_recount_scans").selectAll().where("recount_id", "=", id).orderBy("created_at").execute();
  const byRecord = new Map(scans.filter((s) => s.record_id).map((s) => [s.record_id!, s]));
  const amount = (v: string | null) => (v == null ? null : Number(v));
  const rows = expected.map((e) => {
    const s = byRecord.get(e.id);
    return { ...e, seen: s ? { scan_id: s.id, by: s.matched_by, place_id: s.place_id, amount: amount(s.amount) } : null };
  });
  const fresh = scans.filter((s) => !s.record_id).map((s) => ({ scan_id: s.id, title: s.title, like_id: s.like_id, like_type_id: s.like_type_id ?? null, barcode: s.barcode, place_id: s.place_id, amount: amount(s.amount) }));
  return {
    id: row.id,
    label: row.scope_label,
    scope: row.scope,
    status: row.status,
    created_at: new Date(row.created_at).toISOString(),
    applied: row.applied ?? null,
    expected: rows,
    new: fresh,
    progress: { seen: rows.filter((r) => r.seen).length, expected: rows.length, new: fresh.length },
  };
}

/** The recounts still open, newest first: where a paused one is picked up. */
export async function openRecounts(orgId: string): Promise<Array<{ id: string; label: string; updated_at: string }>> {
  const t = await db(orgId);
  const rows = await t.selectFrom("inventory_recounts").select(["id", "scope_label", "updated_at"]).where("status", "=", "open").orderBy("updated_at", "desc").limit(50).execute();
  return rows.map((r) => ({ id: r.id, label: r.scope_label, updated_at: new Date(r.updated_at).toISOString() }));
}

/** Start a recount, or pick up the one already open over the same scope: a
 *  big collection is counted over days, and a second session would split it. */
export async function startRecount(orgId: string, userId: string | null, rawScope: unknown): Promise<{ id: string; label: string; expected: number; resumed: boolean }> {
  const { scope, label } = await parseRecountScope(orgId, rawScope);
  const expected = await expectedOf(orgId, scope);
  const t = await db(orgId);
  const open = await t
    .selectFrom("inventory_recounts")
    .select(["id"])
    .where("status", "=", "open")
    .where(sql<boolean>`scope = ${JSON.stringify(scope)}::jsonb`)
    .executeTakeFirst();
  if (open) return { id: open.id, label, expected: expected.length, resumed: true };
  const row = await t
    .insertInto("inventory_recounts")
    .values({ scope: JSON.stringify(scope) as never, scope_label: label, created_by: userId })
    .returning("id")
    .executeTakeFirstOrThrow();
  return { id: row.id, label, expected: expected.length, resumed: false };
}

/** The collection's types, when its things belong to a type collection (Spools
 *  under Filament Types): a thing new to the collection is added under one. */
export async function familyOfCollection(orgId: string, collection: string): Promise<Family | null> {
  return (await familiesOf(orgId)).find((f) => f.child === collection) ?? null;
}

export interface RecountScanResult {
  match: RecountMatch;
  /** The type a new thing reads as, when its collection has types. */
  type: { id: string; title: string } | null;
  /** The types a new thing could be, when two read alike: one is picked with type_id. */
  type_candidates?: RecountItem[];
  /** The record it counted, or what it was noted as. */
  title: string | null;
  scan_id: string | null;
  progress: { seen: number; expected: number; new: number };
}

const isUniqueViolation = (e: unknown) => (e as { code?: unknown } | null)?.code === "23505";

/** One thing scanned into a recount. A match is counted at once; a new
 *  thing is noted; a question ("which of these?") or a refusal writes
 *  nothing. Two phones scanning one type at once each get their own record:
 *  the one that loses the race to a record matches again. */
export async function scanIntoRecount(
  orgId: string,
  userId: string | null,
  id: string,
  input: RecountScanInput & { place_id?: string | null; amount?: number | null; type_id?: string | null },
): Promise<RecountScanResult> {
  const t = await db(orgId);
  const row = await t.selectFrom("inventory_recounts").selectAll().where("id", "=", id).executeTakeFirst();
  if (!row) throw new ActionRefusal("That recount no longer exists.");
  if (row.status !== "open") throw new ActionRefusal(`The recount of ${row.scope_label} is finished. Start a new one to scan again.`);
  const amount = input.amount == null ? null : Number(input.amount);
  if (amount !== null && (!Number.isFinite(amount) || amount < 0)) throw new ActionRefusal("The amount left is a number, 0 or more.");
  const expected = await expectedOf(orgId, row.scope);
  const attributes = Object.fromEntries(Object.entries(input.attributes ?? {}).filter(([, v]) => typeof v === "string" || typeof v === "number").map(([k, v]) => [k, String(v)]));

  // A code on no record here may be a Cobblr label printed for one: asked
  // of the registry that knows label codes, never guessed from the digits.
  const code = input.barcode?.trim();
  if (code && !input.record_id && !expected.some((e) => e.barcode === code)) {
    const said = await platform().resolvables.resolve(orgId, code, { surface: "scan", source: "typed" }).catch(() => null);
    if (said?.outcome === "resolved" && expected.some((e) => e.id === said.candidate.entity_id)) input = { ...input, coded_record_id: said.candidate.entity_id };
  }

  // Types of the collection's things (Filament Types for Spools): a thing new
  // here is matched against them, so it is added under its type, not flat.
  const family = await familyOfCollection(orgId, row.scope.collection);
  const types = family ? await expectedOf(orgId, { collection: family.parent }) : [];

  for (let attempt = 0; attempt < 5; attempt++) {
    const seen = new Set((await t.selectFrom("inventory_recount_scans").select("record_id").where("recount_id", "=", id).where("record_id", "is not", null).execute()).map((s) => s.record_id!));
    const match = matchScan(input, expected, seen);
    const progress = (extra = 0, extraNew = 0) => ({ seen: seen.size + extra, expected: expected.length, new: extraNew });
    if (match.kind === "ask" || match.kind === "refused") return { match, type: null, title: null, scan_id: null, progress: await withNew(t, id, progress()) };
    const item = match.kind === "matched" ? expected.find((e) => e.id === match.id)! : null;
    const like = match.kind === "new" && match.like ? expected.find((e) => e.id === match.like) ?? null : null;
    let type: RecountItem | null = null;
    if (match.kind === "new" && types.length) {
      if (input.type_id) {
        type = types.find((x) => x.id === input.type_id) ?? null;
        if (!type) throw new ActionRefusal("That is not one of this collection's types.");
      } else if (!input.new) {
        // Matched against the types with nothing counted: a type can hold any number of things.
        const asType = matchScan({ ...input, record_id: null, coded_record_id: null }, types, new Set());
        if (asType.kind === "ask") return { match, type: null, type_candidates: asType.candidates, title: null, scan_id: null, progress: await withNew(t, id, progress()) };
        if (asType.kind === "matched") type = types.find((x) => x.id === asType.id) ?? null;
      }
    }
    const title = item?.title ?? like?.title ?? type?.title ?? input.text?.trim() ?? (input.barcode ? `Barcode ${input.barcode}` : "Something new");
    try {
      const scan = await t
        .insertInto("inventory_recount_scans")
        .values({
          recount_id: id,
          record_id: item?.id ?? null,
          like_id: like?.id ?? null,
          like_type_id: type?.id ?? null,
          matched_by: match.kind === "matched" ? match.by : "new",
          title: title.slice(0, 200),
          barcode: input.barcode?.trim() || null,
          attributes: JSON.stringify(attributes) as never,
          place_id: input.place_id || null,
          amount: amount === null ? null : String(amount),
          scanned_by: userId,
        })
        .returning("id")
        .executeTakeFirstOrThrow();
      await t.updateTable("inventory_recounts").set({ updated_at: new Date() }).where("id", "=", id).execute();
      return { match, type: type ? { id: type.id, title: type.title } : null, title, scan_id: scan.id, progress: await withNew(t, id, progress(item ? 1 : 0)) };
    } catch (e) {
      if (!isUniqueViolation(e)) throw e;
    }
  }
  throw new ActionRefusal("Too many scans landed on the same things at once. Scan it again.");
}

async function withNew(t: Kysely<InventoryDB>, id: string, p: { seen: number; expected: number; new: number }) {
  const n = await t.selectFrom("inventory_recount_scans").select(sql<number>`count(*)::int`.as("n")).where("recount_id", "=", id).where("record_id", "is", null).executeTakeFirst();
  return { ...p, new: n?.n ?? 0 };
}

/** Take a scan back out (a mis-scan, or the wrong pick): the record it
 *  counted is expected again. */
export async function removeRecountScan(orgId: string, id: string, scanId: string): Promise<{ title: string; label: string }> {
  const t = await db(orgId);
  const row = await t.selectFrom("inventory_recounts").select(["status", "scope_label"]).where("id", "=", id).executeTakeFirst();
  if (!row) throw new ActionRefusal("That recount no longer exists.");
  if (row.status !== "open") throw new ActionRefusal(`The recount of ${row.scope_label} is finished.`);
  const gone = await t.deleteFrom("inventory_recount_scans").where("id", "=", scanId).where("recount_id", "=", id).returning("title").executeTakeFirst();
  if (!gone) throw new ActionRefusal("That scan is not in this recount.");
  return { title: gone.title, label: row.scope_label };
}

export const progressLine = (p: { seen: number; expected: number; new: number }) =>
  `${p.seen} of ${countOf(p.expected, "thing")} seen${p.new ? `, ${p.new} new` : ""}`;
