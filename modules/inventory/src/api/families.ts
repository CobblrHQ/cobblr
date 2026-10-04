// A TYPE collection and the collection of things of that type, read as one:
// Filament Types and Spools are one Filament page, a card per type with its
// spools as rows. The pair is generic: any inventory instance whose config
// names a `parent` instance (the bundle's `parent: { instance, key_fields }`)
// is a child collection of it, and its records point at their type with an
// `instance-of` pairing (what lift-to-type and the parent picker write).
//
// The page reads the pair through GET /family on the TYPE collection, adds a
// thing under a type (or a new type) through POST /family/children, and a
// heal (heal-families.ts) repairs the two shapes a scan used to leave: a type
// row that is really one physical thing, and a thing with no type.
// See docs/design-decisions/holdings-and-units.md ("One page for a type and
// its things").

import { materialTotals } from "./material-ledger.js";
import { materialNumbers, type MaterialNumbers } from "../material-numbers.js";
import { Router, type Request } from "express";
import { withArticle } from "@cobblr/platform-contract/plural";
import { z } from "zod";
import { sql, type Kysely } from "kysely";
import { columnSet, placeNames, platform } from "@cobblr/platform-contract";
import { coerceMetadata } from "@cobblr/platform-contract/entity-metadata";
import { instanceOf, sessionUser, tenantContext, tenantDb, type InventoryDB } from "../db.js";
import { isLowStock } from "../on-hand.js";
import { canonicalColour, coloursFromName, filamentFieldsFromName, formatColour, parseColour } from "@cobblr/platform-contract/colour";
import { asyncHandler, badBody, requireCapability } from "./util.js";

/** Both sides of an instance-of pairing are addressed as the base part kind,
 *  whichever collection they sit in (lift-to-type and the parent picker). */
const PART = "inventory:part";
const NATIVE = columnSet<InventoryDB["inventory_parts"]>()(["name", "manufacturer", "qty", "unit"]);

export interface Family {
  /** The type collection ("filament-types"). */
  parent: string;
  /** The collection of things of those types ("filament"). */
  child: string;
  rel: string;
  keyFields: string[];
  copyFields: string[];
  childNoun: string | null;
  parentNoun: string | null;
}

/** Every type/child collection pair in a workspace, read from each inventory
 *  instance's own config. */
export async function familiesOf(orgId: string): Promise<Family[]> {
  const out: Family[] = [];
  const insts = (await platform().instances.list(orgId)).filter((i) => i.module_name === "inventory" && !i.is_default);
  const configs = new Map<string, Record<string, unknown>>();
  for (const i of insts) configs.set(i.instance_name, (await platform().instances.configOf(orgId, i.instance_name)) ?? {});
  for (const [name, cfg] of configs) {
    const p = cfg.parent as { instance?: string; relationship_kind?: string; key_fields?: string[]; copy_fields?: string[] } | undefined;
    if (!p?.instance || !configs.has(p.instance)) continue;
    out.push({
      parent: p.instance,
      child: name,
      rel: p.relationship_kind || "instance-of",
      keyFields: Array.isArray(p.key_fields) ? p.key_fields : [],
      copyFields: Array.isArray(p.copy_fields) ? p.copy_fields : [],
      childNoun: typeof cfg.item_noun === "string" ? cfg.item_noun : null,
      parentNoun: typeof configs.get(p.instance)!.item_noun === "string" ? (configs.get(p.instance)!.item_noun as string) : null,
    });
  }
  return out;
}

type Row = InventoryDB["inventory_parts"] extends infer T ? { [K in keyof T]: unknown } & { id: string; name: string } : never;

export const norm = (s: unknown) => String(s ?? "").trim().toLowerCase().replace(/\s+/g, " ");

function valueOf(row: Record<string, unknown>, f: string): unknown {
  return NATIVE.has(f) ? row[f] : coerceMetadata(row.metadata)[f];
}

/** How a thing finds its type: every key field when it has them all (the
 *  lift-to-type key), else its own name, so two unrelated things that each
 *  lack a colour are never folded into one type. */
export function typeKey(row: Record<string, unknown>, keyFields: string[]): string {
  const vals = keyFields.map((f) => norm(valueOf(row, f)));
  return keyFields.length && vals.every(Boolean) ? `k:${vals.join("|")}` : `n:${norm(row.name)}`;
}

/** The fields a thing and its type share: the key and copy fields. */
export function sharedFields(from: Record<string, unknown>, fam: Family): { manufacturer: unknown; metadata: Record<string, unknown> } {
  const md = coerceMetadata(from.metadata);
  const metadata: Record<string, unknown> = {};
  for (const f of [...fam.keyFields, ...fam.copyFields]) if (!NATIVE.has(f) && md[f] != null && md[f] !== "") metadata[f] = md[f];
  return { manufacturer: from.manufacturer ?? null, metadata };
}

/** type id → its things' ids. */
export async function childrenOf(orgId: string, fam: Family, typeIds: string[]): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  if (!typeIds.length) return out;
  const pairs = await platform().pairings.findByTargets({ orgId, sourceKind: PART, targetKind: PART, targetIds: typeIds, relationshipKind: fam.rel });
  for (const p of pairs) out.set(p.targetId, [...(out.get(p.targetId) ?? []), p.sourceId]);
  return out;
}

/** The unit a collection's things are counted in, when it declares one. */
async function collectionUnit(orgId: string, instance: string): Promise<string | null> {
  const u = ((await platform().instances.configOf(orgId, instance)) ?? {}).qty_unit;
  return typeof u === "string" && u.trim() ? u.trim() : null;
}

/** A new thing of a type: the type's name and shared fields, its own count
 *  and place, paired to the type. */
export async function addChild(
  db: Kysely<InventoryDB>,
  orgId: string,
  userId: string | null,
  fam: Family,
  type: Row,
  own: { qty?: number; unit?: string | null; location_id?: string | null; name?: string | null; metadata?: Record<string, unknown> },
): Promise<string> {
  const shared = sharedFields(type as Record<string, unknown>, fam);
  // A thing is counted in its collection's unit unless the door says
  // otherwise: a spool added from the Filament page is weighed in kg, not
  // counted "each", so it is used by the gram rather than stepped (#4015).
  const unit = own.unit || (await collectionUnit(orgId, fam.child));
  const created = await db
    .insertInto("inventory_parts")
    .values({
      name: (own.name || type.name).slice(0, 200),
      instance: fam.child as never,
      manufacturer: shared.manufacturer as never,
      qty: (own.qty ?? 1) as never,
      ...(unit ? { unit: unit as never } : {}),
      metadata: sql`${JSON.stringify({ ...shared.metadata, ...(own.metadata ?? {}) })}::jsonb` as never,
    })
    .returning(["id"])
    .executeTakeFirstOrThrow();
  if (own.location_id) {
    await platform()
      .placement.place({ orgId, containee: { kind: PART, id: created.id }, container: { kind: "core-locations:location", id: own.location_id } })
      .catch(async () => {
        await db.updateTable("inventory_parts").set({ location_id: own.location_id } as never).where("id", "=", created.id).execute();
      });
  }
  await platform().pairings.create({ orgId, sourceKind: PART, sourceId: created.id, targetKind: PART, targetId: type.id, relationshipKind: fam.rel, createdBy: userId });
  await platform().events.emit("inventory.part.created", { orgId, partId: created.id });
  return created.id;
}

/** A new type in the type collection, from the fields given. */
export async function addType(db: Kysely<InventoryDB>, orgId: string, fam: Family, t: { name: string; manufacturer?: string | null; metadata?: Record<string, unknown> }): Promise<Row> {
  const row = await db
    .insertInto("inventory_parts")
    .values({
      name: t.name.slice(0, 200),
      instance: fam.parent as never,
      manufacturer: (t.manufacturer ?? null) as never,
      metadata: sql`${JSON.stringify(t.metadata ?? {})}::jsonb` as never,
    })
    .returningAll()
    .executeTakeFirstOrThrow();
  await platform().events.emit("inventory.part.created", { orgId, partId: row.id });
  return row as unknown as Row;
}

// ── heal: the shapes a scan used to leave (heal-families.ts says which) ──

/** One heal never makes more than this many things from one type row. */
const MOST_FROM_ONE_ROW = 50;

type PartRow = { id: string; name: string; metadata: unknown; [k: string]: unknown };

/** The metadata a record should have: empty key fields its name states, and
 *  its colour as #rrggbb. Null when nothing changes. */
export function settledFields(row: PartRow, fam: Family): Record<string, unknown> | null {
  const md = coerceMetadata(row.metadata);
  const next: Record<string, unknown> = { ...md };
  const said = filamentFieldsFromName(row.name) as Record<string, string | undefined>;
  // A name that plainly says several colours ("Dual Color Red and Blue",
  // "Rainbow") is not one colour word; it draws them all, below.
  const several = coloursFromName(row.name);
  if (several) delete said.color;
  for (const f of [...fam.keyFields, ...fam.copyFields]) {
    if ((md[f] == null || md[f] === "") && said[f]) next[f] = said[f];
  }
  // ONE colour field (#3990): a type showed "Colour" and "Colour swatch"
  // side by side, the second empty, so a rainbow read as the pink a scan
  // guessed. The swatch's value folds into the colour when the colour is
  // empty or a plain code, or when the swatch holds several colours; a colour
  // NAME is kept, because types are matched by it. Then the swatch key goes.
  const colour = next.color;
  const colourParsed = parseColour(colour);
  const isWord = typeof colour === "string" && colour.trim() !== "" && !colourParsed;
  const swatch = parseColour(md.color_hex);
  if (swatch && (!isWord || swatch.colours.length > 1)) next.color = formatColour(swatch);
  if ("color_hex" in next) delete next.color_hex;
  // A name that says several colours beats a single colour a scan guessed,
  // never one a person chose.
  const byPerson = (md.field_provenance as Record<string, { by?: unknown }> | undefined)?.color?.by === "person";
  const now = parseColour(next.color);
  if (several && !byPerson && (!now || now.colours.length < 2)) next.color = formatColour(several);
  if (typeof next.color === "string") next.color = canonicalColour(next.color);
  return JSON.stringify(next) === JSON.stringify(md) ? null : next;
}

async function settle(db: Kysely<InventoryDB>, row: PartRow, fam: Family): Promise<boolean> {
  const next = settledFields(row, fam);
  if (!next) return false;
  await db.updateTable("inventory_parts").set({ metadata: sql`${JSON.stringify(next)}::jsonb` as never }).where("id", "=", row.id).execute();
  row.metadata = next;
  return true;
}

/** One heal of a family at a time, per workspace database: the page reads
 *  /family/all from two places at once (the page and its dashboard tile), and
 *  two heals that each saw "no spool under this type" each made one, which is
 *  how one physical spool became two rows (#3990). The transaction only holds
 *  the lock; the heal's own writes go through the pool as before.
 *
 *  Reads in this process wait their turn HERE, before they take a connection
 *  (#4047). Waiting on the advisory lock holds a pooled connection, and the
 *  heal's own queries need more from the same pool, so as many reads at once
 *  as the pool holds (3 in CI, 5 in production) left the heal no connection:
 *  its queries timed out, the route caught that, and a read answered with a
 *  scanned type and no spool under it. The advisory lock stays for a heal in
 *  another process; in this one at most one heal of a family ever waits on it. */
//  Coalesced, not queued: at most one heal of a family runs and one waits
//  behind it, and every later caller shares the waiting one. The waiting one
//  is needed (a record written after the running heal read its snapshot is
//  only covered by a heal that starts after it); a third is not, so a burst
//  of page reads costs two heals, never one per read.
type HealSlot = { running: Promise<number>; queued?: Promise<number> };
const heals = new Map<string, HealSlot>();

function runHeal(key: string, orgId: string, db: Kysely<InventoryDB>, fam: Family): Promise<number> {
  const running = db.transaction().execute(async (trx) => {
    await sql`select pg_advisory_xact_lock(hashtext(${`inventory-family-heal:${fam.parent}`}))`.execute(trx);
    return healFamilyLocked(orgId, db, fam);
  });
  const slot: HealSlot = { running };
  heals.set(key, slot);
  void running.catch(() => undefined).finally(() => {
    // A queued heal takes the slot over when it starts; only the last one out clears it.
    if (heals.get(key) === slot && !slot.queued) heals.delete(key);
  });
  return running;
}

export function healFamily(orgId: string, db: Kysely<InventoryDB>, fam: Family): Promise<number> {
  const key = `${orgId}:${fam.parent}`;
  const slot = heals.get(key);
  if (!slot) return runHeal(key, orgId, db, fam);
  slot.queued ??= slot.running.catch(() => 0).then(() => runHeal(key, orgId, db, fam));
  return slot.queued;
}

async function healFamilyLocked(orgId: string, db: Kysely<InventoryDB>, fam: Family): Promise<number> {
  // The folded field's definition goes too: its values now live in the colour.
  for (const inst of [fam.parent, fam.child]) {
    await platform().fields.retire({ orgId, kind: `${inst}:item`, name: "color_hex" }).catch(() => 0);
  }
  const types = (await db.selectFrom("inventory_parts").selectAll().where("instance", "=", fam.parent as never).where("archived", "=", false).execute()) as unknown as PartRow[];
  const things = (await db.selectFrom("inventory_parts").selectAll().where("instance", "=", fam.child as never).where("archived", "=", false).execute()) as unknown as PartRow[];
  let healed = 0;
  for (const r of [...types, ...things]) if (await settle(db, r, fam)) healed++;
  const kids = await childrenOf(orgId, fam, types.map((t) => t.id));
  const claimed = new Set([...kids.values()].flat());
  const childUnit = await collectionUnit(orgId, fam.child);
  // Things a door made without their collection's unit carry the generic
  // "each", so a spool of a kg collection was stepped by whole spools instead
  // of used by the gram (#4015). "each" is the column's default, never a
  // choice this collection offers, so it takes the collection's unit.
  if (childUnit && childUnit !== "each") {
    const counted = things.filter((t) => t.unit == null || t.unit === "each");
    if (counted.length) {
      await db.updateTable("inventory_parts").set({ unit: childUnit as never }).where("id", "in", counted.map((t) => t.id)).execute();
      for (const t of counted) t.unit = childUnit;
      healed += counted.length;
      console.log(`[inventory] org ${orgId}: ${counted.length} ${fam.child} counted "each" now in ${childUnit}`);
    }
  }

  // A spool sitting in the types table becomes ONE spool under it. Its count
  // is never read as that many spools: a second scan of the same spool lands
  // on the type as "+1 more", and a count of 2 made two rows for one spool
  // (#3990). Any count beyond one is offered on the card to confirm
  // (spools_to_confirm), never invented.
  for (const t of types) {
    const md = coerceMetadata(t.metadata);
    if (kids.get(t.id)?.length || md.scan_source == null) continue;
    const count = Math.max(1, Math.floor(Number(t.qty ?? 0)));
    const { spools_to_confirm: _drop, ...childMd } = md;
    const id = await addChild(db, orgId, null, fam, t as never, {
      qty: 1,
      unit: childUnit,
      location_id: (t.location_id as string | null) ?? null,
      metadata: childMd,
    });
    claimed.add(id);
    if (count > 1) {
      const extra = Math.min(count - 1, MOST_FROM_ONE_ROW);
      await db
        .updateTable("inventory_parts")
        .set({ metadata: sql`coalesce(metadata, '{}'::jsonb) || ${JSON.stringify({ spools_to_confirm: extra })}::jsonb` as never })
        .where("id", "=", t.id)
        .execute();
    }
    healed++;
    console.log(`[inventory] org ${orgId}: ${fam.parent} "${t.name}" held ${count}; filed one ${fam.childNoun ?? "thing"} under it${count > 1 ? `, ${count - 1} more to confirm` : ""}`);
  }

  // Spools with no type.
  const byKey = new Map(types.map((t) => [typeKey(t as never, fam.keyFields), t]));
  for (const s of things) {
    if (claimed.has(s.id)) continue;
    const already = await platform().pairings.findBySources({ orgId, sourceKind: PART, sourceIds: [s.id], targetKind: PART, relationshipKind: fam.rel });
    if (already.length) continue;
    const key = typeKey(s as never, fam.keyFields);
    let type = byKey.get(key);
    if (!type) {
      const shared = sharedFields(s as never, fam);
      type = (await addType(db, orgId, fam, { name: s.name, manufacturer: shared.manufacturer as string | null, metadata: shared.metadata })) as never;
      byKey.set(key, type!);
    }
    await platform().pairings.create({ orgId, sourceKind: PART, sourceId: s.id, targetKind: PART, targetId: type!.id, relationshipKind: fam.rel, createdBy: null });
    healed++;
    console.log(`[inventory] org ${orgId}: ${fam.child} "${s.name}" had no type; filed it under "${type!.name}"`);
  }
  return healed;
}

const THING_COLUMNS = ["id", "name", "qty", "unit", "min_qty", "location_id", "image_path", "metadata", "manufacturer", "created_at"] as const;

function thing(r: Record<string, unknown>) {
  const qty = Number(r.qty ?? 0);
  const min = r.min_qty == null ? null : Number(r.min_qty);
  return {
    id: r.id as string,
    name: r.name as string,
    qty,
    unit: (r.unit as string | null) ?? null,
    min_qty: min,
    low: isLowStock({ onHand: qty, minQty: min }),
    location_id: (r.location_id as string | null) ?? null,
    image_path: (r.image_path as string | null) ?? null,
    metadata: coerceMetadata(r.metadata),
  };
}

async function familyFor(req: Request): Promise<Family | null> {
  const here = instanceOf(req);
  return (await familiesOf(tenantContext(req).org.id)).find((f) => f.parent === here) ?? null;
}

export const familiesRouter = Router({ mergeParams: true });

// The whole family on the TYPE collection's page: every type with its things
// under it, the things no type claims (shown, never hidden), and the counts
// the header and the dashboard say.
familiesRouter.get(
  "/family/all",
  asyncHandler(async (req, res) => {
    const fam = await familyFor(req);
    if (!fam) {
      res.status(404).json({ error: { code: "not_a_type_collection", message: "Nothing in this workspace is filed under these." } });
      return;
    }
    const db = tenantDb(req);
    const orgId = tenantContext(req).org.id;
    // The page puts right what a scan left before it reads (idempotent, and
    // the same reads it is about to make): a workspace sees one shape the
    // moment it looks, not after the next boot pass.
    await healFamily(orgId, db, fam).catch((err) => console.error(`[inventory] family heal on read failed: ${(err as Error).message}`));
    // list-cap-ok: not paged yet, #4134
    const types = await db.selectFrom("inventory_parts").selectAll().where("instance", "=", fam.parent as never).where("archived", "=", false).orderBy("name").limit(1000).execute();
    const things = await db.selectFrom("inventory_parts").select([...THING_COLUMNS]).where("instance", "=", fam.child as never).where("archived", "=", false).orderBy("created_at").limit(5000).execute();
    const byType = await childrenOf(orgId, fam, types.map((t) => t.id));
    const places = await placeNames(orgId, PART, things);
    const sumById = await materialTotals(db, things.map((t) => t.id));
    const factors = new Map<string, number | null>();
    for (const unit of new Set(things.map((t) => t.unit))) factors.set(unit, await platform().units.convert(orgId, 1, unit, "g"));
    const rawById = new Map(things.map((t) => [t.id, t]));
    const numbers = new Map<string, MaterialNumbers & { jobs: number }>();
    for (const type of types) {
      for (const id of byType.get(type.id) ?? []) {
        const t = rawById.get(id);
        if (!t) continue;
        const factor = factors.get(t.unit);
        if (factor == null) continue;
        const md = { ...coerceMetadata(type.metadata), ...coerceMetadata(t.metadata) };
        const sum = sumById.get(id);
        const n = materialNumbers(Number(t.qty) * factor, md.initial_g == null ? null : Number(md.initial_g), Number(md.density) || null, parseFloat(String(md.diameter)) || null,
          [{ delta: Number(sum?.net ?? 0) * factor, kind: null, at: "" }]);
        n.first_used = sum?.first_used ? new Date(sum.first_used).toISOString() : null;
        n.last_used = sum?.last_used ? new Date(sum.last_used).toISOString() : null;
        numbers.set(id, { ...n, jobs: Number(sum?.jobs ?? 0) });
      }
    }
    const thingById = new Map(things.map((t) => [t.id, { ...thing(t as unknown as Record<string, unknown>), location_name: places.get(t.id) ?? null, material: numbers.get(t.id) ?? null }]));
    const claimed = new Set<string>();
    const cards = types.map((t) => {
      const kids = (byType.get(t.id) ?? []).map((id) => thingById.get(id)).filter((x): x is NonNullable<typeof x> => !!x);
      for (const k of kids) claimed.add(k.id);
      return {
        id: t.id,
        name: t.name,
        manufacturer: t.manufacturer,
        image_path: t.image_path,
        metadata: coerceMetadata(t.metadata),
        children: kids,
        count: kids.length,
        remaining: kids.reduce((n, k) => n + k.qty, 0),
        low: kids.length === 0 || kids.some((k) => k.low),
      };
    });
    const unclaimed = [...thingById.values()].filter((t) => !claimed.has(t.id));
    res.json({
      parent: fam.parent,
      child: fam.child,
      child_noun: fam.childNoun,
      parent_noun: fam.parentNoun,
      child_unit: await collectionUnit(orgId, fam.child),
      types: cards,
      unclaimed,
      counts: { types: cards.length, children: thingById.size, low: cards.filter((c) => c.children.some((k) => k.low)).length },
    });
  }),
);

const AddChild = z.object({
  type_id: z.string().uuid().optional(),
  new_type: z.object({ name: z.string().min(1).max(200), manufacturer: z.string().max(200).nullable().optional(), metadata: z.record(z.unknown()).optional() }).optional(),
  qty: z.number().min(0).optional(),
  unit: z.string().max(40).nullable().optional(),
  location_id: z.string().uuid().nullable().optional(),
  name: z.string().max(200).nullable().optional(),
  metadata: z.record(z.unknown()).optional(),
});

// AI-REACH: exempt (the assistant adds a spool with create_record on the child kind, whose auto-lift files it under its type; this is the page's one-tap door for the same write)
familiesRouter.post(
  "/family/children",
  asyncHandler(async (req, res) => {
    if (!(await requireCapability(req, res, "inventory:create-part"))) return;
    const parsed = AddChild.safeParse(req.body ?? {});
    if (!parsed.success) return badBody(res, parsed.error);
    const a = parsed.data;
    if (!a.type_id === !a.new_type) {
      res.status(400).json({ error: { code: "pick_one_type", message: "Pick a type, or name a new one." } });
      return;
    }
    const fam = await familyFor(req);
    if (!fam) {
      res.status(404).json({ error: { code: "not_a_type_collection", message: "Nothing in this workspace is filed under these." } });
      return;
    }
    const db = tenantDb(req);
    const orgId = tenantContext(req).org.id;
    let type: Row | undefined;
    if (a.type_id) {
      type = (await db.selectFrom("inventory_parts").selectAll().where("id", "=", a.type_id).where("instance", "=", fam.parent as never).executeTakeFirst()) as unknown as Row | undefined;
      if (!type) {
        res.status(404).json({ error: { code: "no_such_type", message: "That type is not in this collection." } });
        return;
      }
    } else {
      // Naming a type that already exists files under it rather than making a twin.
      const wanted = norm(a.new_type!.name);
      const existing = await db.selectFrom("inventory_parts").selectAll().where("instance", "=", fam.parent as never).where(sql<boolean>`lower(trim(name)) = ${wanted}`).executeTakeFirst();
      type = (existing as unknown as Row | undefined) ?? (await addType(db, orgId, fam, a.new_type!));
    }
    const id = await addChild(db, orgId, sessionUser(req).id, fam, type!, a);
    await platform().activity.log({
      orgId,
      userId: sessionUser(req).id,
      action: "part_created",
      ref: { module: "inventory", entityType: "part", entityId: id },
      diff: { name: type!.name, under: type!.id },
    });
    res.status(201).json({ id, type_id: type!.id });
  }),
);

const SetType = z.object({ type_id: z.string().uuid() });

// A thing's type changed where the thing is: its page's Type picker. The
// link between a thing and its type is the family's, so a Links row cannot
// remove it; this is the family's own door for moving it to another type.
// AI-REACH: exempt (the record page's Type picker; the assistant files a thing under its type through create_record's auto-lift)
familiesRouter.post(
  "/family/children/:id/type",
  asyncHandler(async (req, res) => {
    if (!(await requireCapability(req, res, "inventory:update-part"))) return;
    const parsed = SetType.safeParse(req.body ?? {});
    if (!parsed.success) return badBody(res, parsed.error);
    const fam = await familyFor(req);
    if (!fam) {
      res.status(404).json({ error: { code: "not_a_type_collection", message: "Nothing in this workspace is filed under these." } });
      return;
    }
    const db = tenantDb(req);
    const orgId = tenantContext(req).org.id;
    const childId = String(req.params.id);
    const child = await db.selectFrom("inventory_parts").select(["id"]).where("id", "=", childId).where("instance", "=", fam.child as never).executeTakeFirst();
    const type = await db.selectFrom("inventory_parts").select(["id", "name"]).where("id", "=", parsed.data.type_id).where("instance", "=", fam.parent as never).executeTakeFirst();
    if (!child || !type) {
      res.status(404).json({ error: { code: "no_such_record", message: child ? "That type is not in this collection." : `That is not ${withArticle(fam.childNoun ?? "thing")} of this collection.` } });
      return;
    }
    const now = await platform().pairings.findBySources({ orgId, sourceKind: PART, sourceIds: [child.id], targetKind: PART, relationshipKind: fam.rel });
    for (const p of now) {
      if (p.targetId !== type.id) await platform().pairings.remove({ orgId, sourceKind: PART, sourceId: child.id, targetKind: PART, targetId: p.targetId, relationshipKind: fam.rel });
    }
    if (!now.some((p) => p.targetId === type.id)) {
      await platform().pairings.create({ orgId, sourceKind: PART, sourceId: child.id, targetKind: PART, targetId: type.id, relationshipKind: fam.rel, createdBy: sessionUser(req).id });
    }
    res.json({ id: child.id, type_id: type.id, type_name: type.name });
  }),
);
