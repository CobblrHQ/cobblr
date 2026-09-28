// One thing kept in several places: a card, and a row per place.
//
// A HOLDING is an inventory record like any other (its own location, qty,
// minimum and lots), paired to the card it belongs to with `holding-of`. So
// everything a record already does keeps working per place, with nothing new:
// low stock against its own minimum, soonest-expiry-first use, the ledger, bin
// scans, placement, labels. What this file adds is the grouping: which records
// are rows of which card, the card's summary, and the three moves (add a
// place, combine two records, split one back out).
//
// The card's own location and quantity are its first row, so combining two
// records that already exist invents nothing. Identity (name, image,
// category...) lives on the card and is written to its holdings, so the same
// supply cannot read differently in two places.
// See docs/design-decisions/holdings-and-units.md.

import { Router, type Request } from "express";
import { z } from "zod";
import { sql, type Kysely } from "kysely";
import { platform } from "@cobblr/platform-contract";
import { coerceMetadata } from "@cobblr/platform-contract/entity-metadata";
import {
  HOLDING_IDENTITY_FIELDS,
  HOLDING_OF,
  identityMetadata,
  rollupHoldings,
  type CardRollup,
} from "@cobblr/platform-contract/holdings";
import { instanceOf, partKindOf, sessionUser, tenantContext, tenantDb, type InventoryDB } from "../db.js";
import { isLowStock } from "../on-hand.js";
import { recordConsumption } from "./stock-ledger.js";
import { asyncHandler, badBody, requireCapability } from "./util.js";

/** One row under a card: the stock of this thing in one place. */
export interface HoldingRow {
  id: string;
  /** True for the card's own row (the card record itself). */
  own: boolean;
  location_id: string | null;
  location_name: string | null;
  qty: number;
  min_qty: number | null;
  low: boolean;
  /** The soonest date stock here goes off; null when undated. */
  expires_on: string | null;
}

/** Where a holdings call runs. A route's request and an action's context
 *  reduce to the same five things, so both doors share one implementation. */
export interface HoldingsCtx {
  orgId: string;
  userId: string | null;
  db: Kysely<InventoryDB>;
  /** The collection (an inventory instance); every read is scoped to it. */
  instance: string;
  /** The entity kind its records are addressed as (pairings, activity). */
  kind: string;
}

export function holdingsCtx(req: Request): HoldingsCtx {
  return {
    orgId: tenantContext(req).org.id,
    userId: sessionUser(req).id,
    db: tenantDb(req),
    instance: instanceOf(req),
    kind: partKindOf(req),
  };
}

/** The context for an action on one record: its collection read off the row. */
export async function holdingsCtxForPart(orgId: string, userId: string | null, partId: string): Promise<HoldingsCtx | null> {
  const db = (await platform().tenants.getDb(orgId)) as Kysely<InventoryDB>;
  const row = await db.selectFrom("inventory_parts").select(["instance"]).where("id", "=", partId).executeTakeFirst();
  if (!row) return null;
  const instance = row.instance;
  return { orgId, userId, db, instance, kind: instance === "inventory" ? "inventory:part" : `${instance}:item` };
}

/** Of these records, which are holdings, and of which card. One query. */
export async function cardOfHoldings(c: HoldingsCtx, ids: string[]): Promise<Map<string, string>> {
  if (!ids.length) return new Map();
  const pairs = await platform().pairings.findBySources({
    orgId: c.orgId,
    sourceKind: c.kind,
    sourceIds: ids,
    targetKind: c.kind,
    relationshipKind: HOLDING_OF,
  });
  return new Map(pairs.map((p) => [p.sourceId, p.targetId]));
}

/** The holdings of each of these cards. One query. */
export async function holdingsOfCards(c: HoldingsCtx, cardIds: string[]): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  if (!cardIds.length) return out;
  const pairs = await platform().pairings.findByTargets({
    orgId: c.orgId,
    sourceKind: c.kind,
    targetKind: c.kind,
    targetIds: cardIds,
    relationshipKind: HOLDING_OF,
  });
  for (const p of pairs) out.set(p.targetId, [...(out.get(p.targetId) ?? []), p.sourceId]);
  return out;
}

/** What a place's row says, read the same way for a holding and for the card's
 *  own row: low against its own minimum, less anything reserved there. */
export async function readHoldingRows(c: HoldingsCtx, ids: string[]): Promise<Map<string, HoldingRow>> {
  const out = new Map<string, HoldingRow>();
  if (!ids.length) return out;
  const rows = await c.db
    .selectFrom("inventory_parts as p")
    .select((eb) => [
      "p.id",
      "p.qty",
      "p.min_qty",
      "p.approximate_qty",
      "p.location_id",
      "p.metadata",
      eb
        .selectFrom("inventory_allocations as a")
        .select(sql<string>`coalesce(sum(a.qty), 0)`.as("v"))
        .whereRef("a.part_id", "=", "p.id")
        .where("a.status", "=", "reserved")
        .as("assigned_qty"),
    ])
    .where("p.id", "in", ids)
    .where("p.instance", "=", c.instance)
    .execute();
  const names = await locationNames(c, rows.map((r) => r.location_id));
  for (const r of rows) {
    const qty = Number(r.qty);
    const minQty = r.min_qty == null ? null : Number(r.min_qty);
    const md = coerceMetadata(r.metadata);
    out.set(r.id, {
      id: r.id,
      own: false,
      location_id: r.location_id,
      location_name: r.location_id ? (names.get(r.location_id) ?? null) : null,
      qty,
      min_qty: minQty,
      low: isLowStock({
        onHand: qty,
        assigned: Number(r.assigned_qty ?? 0),
        minQty,
        approximate: r.approximate_qty == null ? null : Number(r.approximate_qty),
      }),
      expires_on: typeof md.expires_on === "string" && md.expires_on ? md.expires_on : null,
    });
  }
  return out;
}

async function locationNames(c: HoldingsCtx, ids: Array<string | null>): Promise<Map<string, string>> {
  const uniq = [...new Set(ids.filter((x): x is string => !!x))];
  if (!uniq.length) return new Map();
  const resolved = await platform().entities.lookupMany(
    c.orgId,
    uniq.map((id) => ({ kind: "core-locations:location", id })),
  );
  return new Map(resolved.map((r) => [r.id, r.title]));
}

/** The rows under a card, its own first (when it holds anything or has a
 *  place), then its holdings by place name. */
function orderRows(own: HoldingRow | undefined, held: HoldingRow[]): HoldingRow[] {
  const rows: HoldingRow[] = [];
  if (own && (!held.length || own.location_id || own.qty > 0)) rows.push({ ...own, own: true });
  held.sort((a, b) => (a.location_name ?? "").localeCompare(b.location_name ?? ""));
  return [...rows, ...held];
}

/** Every card on a page gains `holdings` (its rows) and `rollup` (its top
 *  line). A record with no holdings is left as it was: one place, one row,
 *  nothing to nest. Two queries for the page, never one per card. */
export async function attachHoldings<T extends { id: string }>(
  c: HoldingsCtx,
  cards: T[],
): Promise<Array<T & { holdings?: HoldingRow[]; rollup?: CardRollup }>> {
  const byCard = await holdingsOfCards(c, cards.map((x) => x.id));
  if (!byCard.size) return cards;
  const rowIds = [...byCard.keys(), ...[...byCard.values()].flat()];
  const rows = await readHoldingRows(c, rowIds);
  return cards.map((card) => {
    const ids = byCard.get(card.id);
    if (!ids) return card;
    const held = ids.map((id) => rows.get(id)).filter((r): r is HoldingRow => !!r);
    const holdings = orderRows(rows.get(card.id), held);
    return { ...card, holdings, rollup: rollupHoldings(holdings) };
  });
}

/** The rows of one card and its top line, for the detail. */
export async function rowsOfCard(c: HoldingsCtx, cardId: string): Promise<{ rows: HoldingRow[]; rollup: CardRollup }> {
  const [withRows] = await attachHoldings(c, [{ id: cardId }]);
  if (withRows?.holdings && withRows.rollup) return { rows: withRows.holdings, rollup: withRows.rollup };
  const own = (await readHoldingRows(c, [cardId])).get(cardId);
  const rows = own ? [{ ...own, own: true }] : [];
  return { rows, rollup: rollupHoldings(rows) };
}

/** A card shows whenever any of its rows would: a search that matches a
 *  holding, a low filter that catches one ambulance, finds the card. Each
 *  holding on the page is replaced by its card (fetched when it is not on the
 *  page), at the place the first of them stood, and never twice. */
export async function liftHoldingsToCards<T extends { id: string }>(
  c: HoldingsCtx,
  rows: T[],
  fetchCards: (ids: string[]) => Promise<T[]>,
): Promise<T[]> {
  const cardOf = await cardOfHoldings(c, rows.map((r) => r.id));
  if (!cardOf.size) return rows;
  const present = new Map(rows.map((r) => [r.id, r]));
  const missing = [...new Set([...cardOf.values()].filter((id) => !present.has(id)))];
  const fetched = missing.length ? await fetchCards(missing) : [];
  for (const f of fetched) present.set(f.id, f);
  const out: T[] = [];
  const seen = new Set<string>();
  for (const r of rows) {
    const id = cardOf.get(r.id) ?? r.id;
    // A card gone by some other door (an undo, a bulk delete) leaves its
    // places standing as records of their own, never hidden.
    const card = present.get(id) ?? r;
    if (seen.has(card.id)) continue;
    seen.add(card.id);
    out.push(card);
  }
  return out;
}

/** The card a record belongs to (itself, when it is not a holding). */
export async function cardIdOf(c: HoldingsCtx, id: string): Promise<string> {
  return (await cardOfHoldings(c, [id])).get(id) ?? id;
}

/** Write a card's identity to its holdings (or, from a holding, to its card and
 *  its siblings), so one supply never reads two ways. `fromId` already has it. */
export async function spreadIdentity(c: HoldingsCtx, fromId: string, patch: Record<string, unknown>): Promise<void> {
  const set: Record<string, unknown> = {};
  for (const k of HOLDING_IDENTITY_FIELDS) if (k in patch) set[k] = patch[k];
  if (!Object.keys(set).length) return;
  const cardId = await cardIdOf(c, fromId);
  const family = [cardId, ...((await holdingsOfCards(c, [cardId])).get(cardId) ?? [])].filter((id) => id !== fromId);
  if (!family.length) return;
  await c.db
    .updateTable("inventory_parts")
    .set({ ...set, updated_at: new Date() } as never)
    .where("id", "in", family)
    .where("instance", "=", c.instance)
    .execute();
}

/** Before a record is deleted: a card's holdings stand on their own (stock in
 *  an ambulance is never deleted because the closet's record was), and a
 *  deleted holding leaves no link behind. */
export async function releaseForDelete(c: HoldingsCtx, id: string): Promise<void> {
  for (const h of (await holdingsOfCards(c, [id])).get(id) ?? []) {
    await platform().pairings.remove({ orgId: c.orgId, sourceKind: c.kind, sourceId: h, targetKind: c.kind, targetId: id, relationshipKind: HOLDING_OF });
  }
  const card = (await cardOfHoldings(c, [id])).get(id);
  if (card) {
    await platform().pairings.remove({ orgId: c.orgId, sourceKind: c.kind, sourceId: id, targetKind: c.kind, targetId: card, relationshipKind: HOLDING_OF });
  }
}

type Refusal = { status: number; error: { code: string; message: string; holding_id?: string } };

async function loadCard(c: HoldingsCtx, id: string) {
  return c.db.selectFrom("inventory_parts").selectAll().where("id", "=", id).where("instance", "=", c.instance).executeTakeFirst();
}

/** Where a card already keeps stock, its own row included: place → record. */
async function placesOf(c: HoldingsCtx, cardId: string): Promise<Map<string, string>> {
  const ids = [cardId, ...((await holdingsOfCards(c, [cardId])).get(cardId) ?? [])];
  const rows = await c.db.selectFrom("inventory_parts").select(["id", "location_id"]).where("id", "in", ids).execute();
  return new Map(rows.filter((r) => r.location_id).map((r) => [r.location_id!, r.id]));
}

/** Keep this thing in one more place: a new record, the card's identity, its
 *  own qty and minimum, placed there and paired to the card. From any row of
 *  the card; one row per place. */
export async function addHolding(
  c: HoldingsCtx,
  fromId: string,
  input: { location_id: string; qty: number; min_qty?: number | null },
): Promise<{ id: string; card_id: string } | Refusal> {
  const cardId = await cardIdOf(c, fromId);
  const card = await loadCard(c, cardId);
  if (!card) return { status: 404, error: { code: "not_found", message: "That item does not exist." } };
  const already = (await placesOf(c, card.id)).get(input.location_id);
  if (already) {
    return {
      status: 409,
      error: { code: "already_held_there", message: "This is already kept there. Change the count on that row instead.", holding_id: already },
    };
  }
  const identity: Record<string, unknown> = {};
  for (const k of HOLDING_IDENTITY_FIELDS) {
    const v = (card as Record<string, unknown>)[k];
    if (v !== undefined) identity[k] = v;
  }
  const inserted = await c.db
    .insertInto("inventory_parts")
    .values({
      ...identity,
      name: card.name,
      unit: card.unit,
      instance: c.instance,
      qty: String(input.qty),
      min_qty: input.min_qty == null ? null : String(input.min_qty),
      metadata: identityMetadata(coerceMetadata(card.metadata)),
    } as never)
    .returning(["id"])
    .executeTakeFirstOrThrow();
  try {
    await platform().placement.place({
      orgId: c.orgId,
      containee: { kind: "inventory:part", id: inserted.id },
      container: { kind: "core-locations:location", id: input.location_id },
    });
  } catch {
    await c.db.updateTable("inventory_parts").set({ location_id: input.location_id }).where("id", "=", inserted.id).execute();
  }
  await platform().pairings.create({
    orgId: c.orgId,
    sourceKind: c.kind,
    sourceId: inserted.id,
    targetKind: c.kind,
    targetId: card.id,
    relationshipKind: HOLDING_OF,
    createdBy: c.userId,
  });
  if (input.qty > 0) {
    await recordConsumption(c.db, { partId: inserted.id, delta: input.qty, reason: "counted in a new place", sourceKind: c.kind, sourceId: card.id });
  }
  await platform().activity.log({
    orgId: c.orgId,
    userId: c.userId,
    action: "holding_added",
    ref: { module: "inventory", entityType: "part", entityId: card.id },
    diff: { holding_id: inserted.id, location_id: input.location_id, qty: input.qty },
  });
  platform().events.emit("inventory.part.created", { orgId: c.orgId, partId: inserted.id });
  return { id: inserted.id, card_id: card.id };
}

/** These records are the same thing in other places: make each a row of this
 *  card. Never automatic; somebody says so. A record that was itself a card
 *  brings its rows with it, and every row takes the card's identity. */
export async function combineInto(c: HoldingsCtx, targetId: string, ids: string[]): Promise<{ card_id: string; combined: string[] } | Refusal> {
  const cardId = await cardIdOf(c, targetId);
  const card = await loadCard(c, cardId);
  if (!card) return { status: 404, error: { code: "not_found", message: "That item does not exist." } };
  const incoming = [...new Set(ids.filter((id) => id !== cardId))];
  if (!incoming.length) return { card_id: cardId, combined: [] };
  const found = await c.db.selectFrom("inventory_parts").select(["id"]).where("id", "in", incoming).where("instance", "=", c.instance).execute();
  if (found.length !== incoming.length) return { status: 404, error: { code: "not_found", message: "One of those items is not in this collection." } };
  const cardOf = await cardOfHoldings(c, incoming);
  if ([...cardOf.values()].some((x) => x !== cardId)) {
    return { status: 409, error: { code: "held_elsewhere", message: "One of those is already kept under another item. Split it out of that one first." } };
  }
  // A record that is a card itself brings its own rows along.
  const theirRows = await holdingsOfCards(c, incoming);
  const moving = [...incoming, ...[...theirRows.values()].flat()].filter((id) => cardOf.get(id) !== cardId);
  const places = await placesOf(c, cardId);
  const movingRows = moving.length
    ? await c.db.selectFrom("inventory_parts").select(["id", "location_id", "name"]).where("id", "in", moving).execute()
    : [];
  for (const r of movingRows) {
    if (r.location_id && places.has(r.location_id)) {
      return { status: 409, error: { code: "same_place", message: `This is already kept where "${r.name}" is. Add its count there instead of combining the two.` } };
    }
    if (r.location_id) places.set(r.location_id, r.id);
  }
  for (const [oldCard, held] of theirRows) {
    for (const h of held) {
      await platform().pairings.remove({ orgId: c.orgId, sourceKind: c.kind, sourceId: h, targetKind: c.kind, targetId: oldCard, relationshipKind: HOLDING_OF });
    }
  }
  const combined: string[] = [];
  for (const r of movingRows) {
    await platform().pairings.create({ orgId: c.orgId, sourceKind: c.kind, sourceId: r.id, targetKind: c.kind, targetId: cardId, relationshipKind: HOLDING_OF, createdBy: c.userId });
    combined.push(r.id);
  }
  const identity: Record<string, unknown> = {};
  for (const k of HOLDING_IDENTITY_FIELDS) identity[k] = (card as Record<string, unknown>)[k];
  if (combined.length) {
    await c.db.updateTable("inventory_parts").set({ ...identity, updated_at: new Date() } as never).where("id", "in", combined).execute();
  }
  await platform().activity.log({
    orgId: c.orgId,
    userId: c.userId,
    action: "holdings_combined",
    ref: { module: "inventory", entityType: "part", entityId: cardId },
    diff: { combined },
  });
  return { card_id: cardId, combined };
}

/** This place's stock is its own thing after all: it stops being a row of its
 *  card and becomes a record of its own, with everything it had. */
export async function splitHolding(c: HoldingsCtx, holdingId: string): Promise<{ id: string; card_id: string } | Refusal> {
  const cardId = (await cardOfHoldings(c, [holdingId])).get(holdingId);
  if (!cardId) return { status: 404, error: { code: "not_a_holding", message: "That is not one of an item's places." } };
  await platform().pairings.remove({ orgId: c.orgId, sourceKind: c.kind, sourceId: holdingId, targetKind: c.kind, targetId: cardId, relationshipKind: HOLDING_OF });
  await platform().activity.log({
    orgId: c.orgId,
    userId: c.userId,
    action: "holding_split",
    ref: { module: "inventory", entityType: "part", entityId: cardId },
    diff: { holding_id: holdingId },
  });
  return { id: holdingId, card_id: cardId };
}

const isRefusal = (x: object): x is Refusal => "error" in x;

// ── routes ───────────────────────────────────────────────────────────

export const holdingsRouter = Router({ mergeParams: true });

holdingsRouter.get(
  "/:id/holdings",
  asyncHandler(async (req, res) => {
    const c = holdingsCtx(req);
    const found = await loadCard(c, req.params.id!);
    if (!found) {
      res.status(404).json({ error: { code: "not_found", message: "That item does not exist." } });
      return;
    }
    const cardId = await cardIdOf(c, found.id);
    res.json({ card_id: cardId, ...(await rowsOfCard(c, cardId)) });
  }),
);

const AddHolding = z.object({
  location_id: z.string().uuid(),
  qty: z.coerce.number().min(0).max(1_000_000).default(0),
  min_qty: z.coerce.number().min(0).max(1_000_000).nullable().optional(),
});

// AI-REACH: action inventory:add-holding
// AI-ACTION: inventory:add-holding
holdingsRouter.post(
  "/:id/holdings",
  asyncHandler(async (req, res) => {
    if (!(await requireCapability(req, res, "inventory:create-part"))) return;
    const parsed = AddHolding.safeParse(req.body ?? {});
    if (!parsed.success) return badBody(res, parsed.error);
    const out = await addHolding(holdingsCtx(req), req.params.id!, parsed.data);
    if (isRefusal(out)) {
      res.status(out.status).json({ error: out.error });
      return;
    }
    res.status(201).json(out);
  }),
);

const Combine = z.object({ ids: z.array(z.string().uuid()).min(1).max(100) });

// AI-REACH: action inventory:combine-holdings
// AI-ACTION: inventory:combine-holdings
holdingsRouter.post(
  "/:id/holdings/combine",
  asyncHandler(async (req, res) => {
    if (!(await requireCapability(req, res, "inventory:create-part"))) return;
    const parsed = Combine.safeParse(req.body ?? {});
    if (!parsed.success) return badBody(res, parsed.error);
    const out = await combineInto(holdingsCtx(req), req.params.id!, parsed.data.ids);
    if (isRefusal(out)) {
      res.status(out.status).json({ error: out.error });
      return;
    }
    res.json(out);
  }),
);

// AI-REACH: action inventory:split-holding
// AI-ACTION: inventory:split-holding
holdingsRouter.post(
  "/:id/holdings/:holdingId/split",
  asyncHandler(async (req, res) => {
    if (!(await requireCapability(req, res, "inventory:create-part"))) return;
    const c = holdingsCtx(req);
    const actual = (await cardOfHoldings(c, [req.params.holdingId!])).get(req.params.holdingId!);
    if (actual !== req.params.id) {
      res.status(404).json({ error: { code: "not_a_holding", message: "That is not one of this item's places." } });
      return;
    }
    const out = await splitHolding(c, req.params.holdingId!);
    if (isRefusal(out)) {
      res.status(out.status).json({ error: out.error });
      return;
    }
    res.json(out);
  }),
);

// ── actions (the assistant's door, and a wire's) ─────────────────────

const refusalResult = (r: Refusal) => ({ ok: false as const, error: r.error.code, message: r.error.message });

export function registerHoldingActions(): void {
  platform().actions.registerHandler("inventory.add-holding", async (ctx) => {
    const a = (ctx.args as { partId?: string; location_id?: string; qty?: number; min_qty?: number | null } | null) ?? {};
    const partId = a.partId ?? (ctx.entity as { id?: string } | null)?.id;
    if (!partId) return { ok: false, error: "missing partId" };
    if (!a.location_id) return { ok: false, error: "missing location_id", message: "Say which place to keep it in." };
    const c = await holdingsCtxForPart(ctx.orgId, ctx.userId ?? null, partId);
    if (!c) return { ok: false, error: "part_not_found" };
    const qty = Number(a.qty ?? 0);
    const out = await addHolding(c, partId, {
      location_id: a.location_id,
      qty: Number.isFinite(qty) && qty > 0 ? qty : 0,
      min_qty: a.min_qty == null ? null : Number(a.min_qty),
    });
    return isRefusal(out) ? refusalResult(out) : { ok: true, ...out };
  });

  platform().actions.registerHandler("inventory.combine-holdings", async (ctx) => {
    const a = (ctx.args as { partId?: string; ids?: unknown } | null) ?? {};
    const partId = a.partId ?? (ctx.entity as { id?: string } | null)?.id;
    if (!partId) return { ok: false, error: "missing partId" };
    const ids = (Array.isArray(a.ids) ? a.ids : typeof a.ids === "string" ? a.ids.split(",") : []).map((x) => String(x).trim()).filter(Boolean);
    if (!ids.length) return { ok: false, error: "missing ids", message: "Say which records are the same thing." };
    const c = await holdingsCtxForPart(ctx.orgId, ctx.userId ?? null, partId);
    if (!c) return { ok: false, error: "part_not_found" };
    const out = await combineInto(c, partId, ids);
    return isRefusal(out) ? refusalResult(out) : { ok: true, ...out };
  });

  platform().actions.registerHandler("inventory.split-holding", async (ctx) => {
    const a = (ctx.args as { partId?: string } | null) ?? {};
    const partId = a.partId ?? (ctx.entity as { id?: string } | null)?.id;
    if (!partId) return { ok: false, error: "missing partId" };
    const c = await holdingsCtxForPart(ctx.orgId, ctx.userId ?? null, partId);
    if (!c) return { ok: false, error: "part_not_found" };
    const out = await splitHolding(c, partId);
    return isRefusal(out) ? refusalResult(out) : { ok: true, ...out };
  });
}
