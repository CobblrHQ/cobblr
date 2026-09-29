// Two ways to look at stock that no single list gives: what one PLACE carries,
// and what is going off SOON, wherever it is. Both span every collection
// (supplies, groceries, a pantry), because a vehicle carries all of them and a
// lot does not care which list it was entered in.
//
// Each row is a record at a place, so what it says (count, minimum, low, lots)
// is exactly what that record's own page says: one reading, never a second
// computation. See docs/design-decisions/holdings-and-units.md (phase 3).

import { Router, type Request } from "express";
import { z } from "zod";
import { sql, type Kysely } from "kysely";
import { platform } from "@cobblr/platform-contract";
import { coerceMetadata } from "@cobblr/platform-contract/entity-metadata";
import { daysUntil, type Day } from "@cobblr/platform-contract/day";
import { openRecordPath } from "@cobblr/platform-contract/instance-detail";
import { HOLDING_OF } from "@cobblr/platform-contract/holdings";
import { instanceOf, sessionUser, tenantContext, tenantDb, type InventoryDB } from "../db.js";
import { isLowStock } from "../on-hand.js";
import { batchesFrom, sortBatches, type Batch } from "../batches.js";
import { asyncHandler, badBody } from "./util.js";

const LOCATION = "core-locations:location";

const kindOf = (instance: string) => (instance === "inventory" ? "inventory:part" : `${instance}:item`);

/** Every location, id → { name, parent }, read through the locations module's
 *  own resolver (never its table). A workspace's places are a few hundred at
 *  most, so the tree is walked in memory. */
async function locationTree(orgId: string): Promise<Map<string, { name: string; parent: string | null }>> {
  const out = new Map<string, { name: string; parent: string | null }>();
  const res = await platform().entities.list(orgId, LOCATION, { limit: 5000 });
  for (const l of res.items) {
    const parent = typeof l.fields.parent_id === "string" ? l.fields.parent_id : null;
    out.set(l.id, { name: l.title, parent });
  }
  return out;
}

/** A place and everything inside it (a vehicle's compartments are the vehicle). */
function within(tree: Map<string, { parent: string | null }>, root: string): Set<string> {
  const ids = new Set([root]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const [id, l] of tree) {
      if (!ids.has(id) && l.parent && ids.has(l.parent)) {
        ids.add(id);
        grew = true;
      }
    }
  }
  return ids;
}

export interface PlaceRow {
  id: string;
  /** The card this row is a place of, when it is one; null for a record kept
   *  in one place (it is its own card). */
  card_id: string | null;
  name: string;
  instance: string;
  kind: string;
  detail_path: string;
  location_id: string | null;
  location_name: string | null;
  qty: number;
  unit: string;
  min_qty: number | null;
  low: boolean;
  expires_on: string | null;
  lots: Batch[];
}

/** Which collections a read covers. Required, and spelled out: a collection's
 *  own tab listed every collection's lots under its heading (#4000: groceries
 *  under Bookshelf), because "all of them" was what a missing filter meant. A
 *  place's Stock here is the one reader that means every collection (a closet
 *  holds groceries and tools alike), and says so. */
type Scope = { instance: string } | "every-collection";

async function readRows(orgId: string, db: Kysely<InventoryDB>, scope: Scope, locationIds: string[] | null, names: Map<string, { name: string }>): Promise<PlaceRow[]> {
  let q = db
    .selectFrom("inventory_parts as p")
    .select((eb) => [
      "p.id",
      "p.name",
      "p.instance",
      "p.qty",
      "p.unit",
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
    .where("p.archived", "=", false);
  if (scope !== "every-collection") q = q.where("p.instance", "=", scope.instance);
  if (locationIds) q = q.where("p.location_id", "in", locationIds.length ? locationIds : ["00000000-0000-0000-0000-000000000000"]);
  else q = q.where(sql<boolean>`(p.metadata ? 'expires_on' or p.metadata ? 'batches')`);
  const rows = await q.orderBy("p.name").limit(2000).execute();

  // Which of these are places of a card, per collection (a pairing names the kind).
  const cardOf = new Map<string, string>();
  const byInstance = new Map<string, string[]>();
  for (const r of rows) byInstance.set(r.instance, [...(byInstance.get(r.instance) ?? []), r.id]);
  for (const [instance, ids] of byInstance) {
    const kind = kindOf(instance);
    const pairs = await platform().pairings.findBySources({ orgId, sourceKind: kind, sourceIds: ids, targetKind: kind, relationshipKind: HOLDING_OF });
    for (const p of pairs) cardOf.set(p.sourceId, p.targetId);
  }

  return rows.map((r) => {
    const qty = Number(r.qty);
    const minQty = r.min_qty == null ? null : Number(r.min_qty);
    const md = coerceMetadata(r.metadata);
    const expires = typeof md.expires_on === "string" && md.expires_on ? md.expires_on : null;
    return {
      id: r.id,
      card_id: cardOf.get(r.id) ?? null,
      name: r.name,
      instance: r.instance,
      kind: kindOf(r.instance),
      detail_path: openRecordPath(kindOf(r.instance), r.id),
      location_id: r.location_id,
      location_name: r.location_id ? (names.get(r.location_id)?.name ?? null) : null,
      qty,
      unit: r.unit,
      min_qty: minQty,
      low: isLowStock({ onHand: qty, assigned: Number(r.assigned_qty ?? 0), minQty, approximate: r.approximate_qty == null ? null : Number(r.approximate_qty) }),
      expires_on: expires,
      lots: batchesFrom(md, qty, expires),
    };
  });
}

async function today(req: Request): Promise<Day> {
  return platform().accounts.dayFor(sessionUser(req).id, { said: req.query.today });
}

export const stockRouter = Router({ mergeParams: true });

// What one place carries, across every collection: count against minimum, what
// is low, when each thing goes off. A place's compartments count as the place.
stockRouter.get(
  "/at/:locationId",
  asyncHandler(async (req, res) => {
    const orgId = tenantContext(req).org.id;
    const locationId = req.params.locationId!;
    const tree = await locationTree(orgId);
    if (!tree.has(locationId)) {
      res.status(404).json({ error: { code: "not_found", message: "That place does not exist." } });
      return;
    }
    const places = within(tree, locationId);
    const rows = await readRows(orgId, tenantDb(req), "every-collection", [...places], tree);
    const day = await today(req);
    res.json({
      location_id: locationId,
      today: day,
      items: rows,
      low: rows.filter((r) => r.low).length,
      expiring: rows.filter((r) => r.expires_on && daysUntil(r.expires_on as Day, day) <= 30).length,
    });
  }),
);

const Expiring = z.object({
  within: z.coerce.number().int().min(0).max(3650).default(30),
  // The collection whose tab is asking; the request's own collection when unsaid.
  collection: z.string().trim().min(1).max(80).optional(),
});

// What of THIS collection is going off soon, wherever it is: one line per LOT (a closet can hold
// a lot that is fine beside one that expires Friday), grouped by place, the
// soonest place first. Already past its date is included, first of all.
stockRouter.get(
  "/expiring",
  asyncHandler(async (req, res) => {
    const parsed = Expiring.safeParse(req.query);
    if (!parsed.success) return badBody(res, parsed.error);
    const orgId = tenantContext(req).org.id;
    const tree = await locationTree(orgId);
    // The collection it is asked from: Bookshelf's tab is Bookshelf's lots.
    const rows = await readRows(orgId, tenantDb(req), { instance: parsed.data.collection ?? instanceOf(req) }, null, tree);
    const day = await today(req);
    type Line = { part_id: string; card_id: string | null; name: string; instance: string; kind: string; detail_path: string; qty: number; unit: string; lot: string | null; expires_on: string; days: number };
    const groups = new Map<string, { location_id: string | null; location_name: string | null; lots: Line[] }>();
    for (const r of rows) {
      const lots = r.lots.length ? r.lots : r.expires_on ? [{ received_on: "", expires_on: r.expires_on, qty: r.qty }] : [];
      for (const l of sortBatches(lots)) {
        if (!l.expires_on || l.qty <= 0) continue;
        const days = daysUntil(l.expires_on as Day, day);
        if (days > parsed.data.within) continue;
        const key = r.location_id ?? "";
        const g = groups.get(key) ?? { location_id: r.location_id, location_name: r.location_name, lots: [] };
        g.lots.push({ part_id: r.id, card_id: r.card_id, name: r.name, instance: r.instance, kind: r.kind, detail_path: r.detail_path, qty: l.qty, unit: r.unit, lot: l.lot ?? null, expires_on: l.expires_on, days });
        groups.set(key, g);
      }
    }
    const places = [...groups.values()]
      .map((g) => ({ ...g, lots: g.lots.sort((a, b) => a.days - b.days || a.name.localeCompare(b.name)) }))
      .sort((a, b) => (a.lots[0]?.days ?? 0) - (b.lots[0]?.days ?? 0) || (a.location_name ?? "").localeCompare(b.location_name ?? ""));
    res.json({ today: day, within: parsed.data.within, places });
  }),
);
