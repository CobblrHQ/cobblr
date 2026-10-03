import { roundMoneyAmount, fieldCurrency } from "@cobblr/platform-contract/money";
import { fieldDay } from "@cobblr/platform-contract/field-day";
// Parts installed in things built from them: 2 of 4 RAM sticks inside a
// computer, an SSD in it, the rest on the shelf.
//
// Placement holds what is inside what; this file is inventory's half of it.
// It tells the kernel how a counted record splits ("2 of these 4") and how
// two records of one thing in the same container become one again, so a
// second stick installed later, or a part taken back to its spares, never
// leaves two rows of the same thing side by side. The split-off record is a
// holding of the same card (one-thing-many-places), with a computer as its
// place instead of a shelf.
//
// It also says what a record is worth (unit cost times count), which is what
// a computer's built value and every total add up, each record once.

import { installedIn, platform } from "@cobblr/platform-contract";
import { HOLDING_OF, identityMetadata, HOLDING_IDENTITY_FIELDS } from "@cobblr/platform-contract/holdings";
import { coerceMetadata } from "@cobblr/platform-contract/entity-metadata";
import type { Kysely } from "kysely";
import type { InventoryDB } from "../db.js";
import { cardIdOf, cardOfHoldings, holdingsCtxForPart, holdingsOfCards, isRefusal, loadCard, moveLots } from "./holdings.js";

const PART = "inventory:part";

async function dbOf(orgId: string): Promise<Kysely<InventoryDB>> {
  return (await platform().tenants.getDb(orgId)) as Kysely<InventoryDB>;
}

/** How many a record stands for. An estimate nobody counted (an assortment
 *  of roughly fifty) is not split: it goes in whole. */
async function quantityOf(orgId: string, id: string): Promise<number | null> {
  const row = await (await dbOf(orgId)).selectFrom("inventory_parts").select(["qty", "approximate_qty"]).where("id", "=", id).executeTakeFirst();
  if (!row || row.approximate_qty != null) return null;
  const n = Number(row.qty);
  return Number.isFinite(n) ? n : null;
}

/** `qty` of this record into a new record of the same thing: a holding of its
 *  card, with the lots that move (soonest-expiring first) and its unit cost,
 *  placed nowhere yet. The caller places it. */
async function split(args: { orgId: string; id: string; qty: number; userId: string | null }): Promise<string> {
  const c = await holdingsCtxForPart(args.orgId, args.userId, args.id);
  if (!c) throw new Error("placement: that item does not exist");
  const cardId = await cardIdOf(c, args.id);
  const card = await loadCard(c, cardId);
  const from = await c.db.selectFrom("inventory_parts").select(["cost"]).where("id", "=", args.id).executeTakeFirst();
  if (!card || !from) throw new Error("placement: that item does not exist");
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
      qty: "0",
      cost: from.cost ?? card.cost ?? null,
      metadata: identityMetadata(coerceMetadata(card.metadata)),
    } as never)
    .returning(["id"])
    .executeTakeFirstOrThrow();
  await platform().pairings.create({
    orgId: c.orgId,
    sourceKind: c.kind,
    sourceId: inserted.id,
    targetKind: c.kind,
    targetId: cardId,
    relationshipKind: HOLDING_OF,
    createdBy: c.userId,
  });
  const moved = await moveLots(c, args.id, inserted.id, args.qty, undefined, "where it was", "where it is going");
  if (isRefusal(moved)) throw new Error(`placement: ${moved.error.message}`);
  return inserted.id;
}

/** Records of the same thing in one container become one: the card, when it
 *  is among them, keeps its record; otherwise the one already there does.
 *  The others give it their stock (lot by lot) and are retired: unpaired,
 *  taken out and archived, never deleted, so their ledger still reads back. */
async function settle(args: { orgId: string; id: string; container: { kind: string; id: string }; userId: string | null }): Promise<string> {
  const c = await holdingsCtxForPart(args.orgId, args.userId, args.id);
  if (!c) return args.id;
  const cardId = await cardIdOf(c, args.id);
  const family = new Set([cardId, ...((await holdingsOfCards(c, [cardId])).get(cardId) ?? [])]);
  if (family.size < 2) return args.id;
  const inside = await platform().placement.contents({ orgId: args.orgId, container: args.container });
  const together = [...new Set([args.id, ...inside.filter((t) => t.kind === PART && family.has(t.id)).map((t) => t.id)])];
  if (together.length < 2) return args.id;
  const keep = together.includes(cardId) ? cardId : (together.find((id) => id !== args.id) ?? args.id);
  const rows = await c.db.selectFrom("inventory_parts").select(["id", "qty"]).where("id", "in", together).execute();
  const qtyOf = new Map(rows.map((r) => [r.id, Number(r.qty)]));
  for (const id of together) {
    if (id === keep) continue;
    const n = qtyOf.get(id) ?? 0;
    if (n > 0) {
      const moved = await moveLots(c, id, keep, n, undefined, "the same place", "the same place");
      if (isRefusal(moved)) throw new Error(`placement: ${moved.error.message}`);
    }
    const holdingOf = (await cardOfHoldings(c, [id])).get(id);
    if (holdingOf) {
      await platform().pairings.remove({ orgId: c.orgId, sourceKind: c.kind, sourceId: id, targetKind: c.kind, targetId: holdingOf, relationshipKind: HOLDING_OF });
    }
    await platform().placement.remove({ orgId: c.orgId, containee: { kind: PART, id } });
    await c.db.updateTable("inventory_parts").set({ archived: true, updated_at: new Date() } as never).where("id", "=", id).execute();
  }
  return keep;
}

/** What each record is worth: its unit cost times its count. A place's row
 *  without a cost of its own is priced at its card's. Archived records (put
 *  away, or rows joined into another) count for nothing in "all". */
async function valueOf(orgId: string, ids: string[] | "all"): Promise<Map<string, import("@cobblr/platform-contract").DatedMoney | null>> {
  const db = await dbOf(orgId);
  const main = await platform().money.currency(orgId);
  const acquired = (await platform().entities.roledFieldsFor(orgId, PART)).find((f) => f.field_role === "acquired-on");
  let q = db.selectFrom("inventory_parts").select(["id", "qty", "cost", "instance", "metadata", "created_at"]);
  q = ids === "all" ? q.where("archived", "=", false) : q.where("id", "in", ids.length ? ids : ["00000000-0000-0000-0000-000000000000"]);
  const rows = await q.execute();
  const out = new Map<string, import("@cobblr/platform-contract").DatedMoney | null>();
  const unpriced = rows.filter((r) => r.cost == null).map((r) => r.id);
  const cardCost = new Map<string, { cost: number; metadata: unknown; created_at: unknown }>();
  if (unpriced.length) {
    const pairs = await platform().pairings.findBySources({ orgId, sourceKind: PART, sourceIds: unpriced, targetKind: PART, relationshipKind: HOLDING_OF });
    const cards = [...new Set(pairs.map((p) => p.targetId))];
    if (cards.length) {
      const priced = await db.selectFrom("inventory_parts").select(["id", "cost", "metadata", "created_at"]).where("id", "in", cards).execute();
      const byCard = new Map(priced.map((p) => [p.id, p]));
      for (const p of pairs) {
        const cost = byCard.get(p.targetId);
        if (cost?.cost != null) cardCost.set(p.sourceId, { ...cost, cost: Number(cost.cost) });
      }
    }
  }
  for (const r of rows) {
    const unit = r.cost != null ? Number(r.cost) : cardCost.get(r.id)?.cost;
    const n = Number(r.qty);
    if (Number.isFinite(n) && n <= 0) continue;
    if (unit === undefined || !Number.isFinite(unit) || !Number.isFinite(n)) { out.set(r.id, null); continue; }
    const source = r.cost != null ? r : cardCost.get(r.id)!;
    const meta = source.metadata as { [key: string]: unknown; receipt?: { date?: string }; acquired_on?: string } | null;
    out.set(r.id, { value: { amount: roundMoneyAmount(unit * n, fieldCurrency(source.metadata, "cost", main)), currency: fieldCurrency(source.metadata, "cost", main) }, day: fieldDay((acquired ? meta?.[acquired.name] : null) || meta?.receipt?.date || meta?.acquired_on) || fieldDay(source.created_at) || "" });
  }
  return out;
}

let registered = false;

export function registerInstalledParts(): void {
  if (registered) return;
  registered = true;
  platform().placement.registerQuantity(PART, { quantityOf, split, settle });
  // A part's value is its cost: seen only by a viewer who may see costs.
  platform().placement.registerValue(PART, valueOf, {
    readScope: "inventory:view-costs",
    insuranceDetails: async (orgId, ids) => {
      const rows = await (await dbOf(orgId)).selectFrom("inventory_parts").select(["id", "serial_number"]).where("id", "in", ids).execute();
      return new Map(rows.map((r) => [r.id, { serial: r.serial_number }]));
    },
  });
}

/** Where some of a thing is installed: the holder and how many are in it. */
export interface InstalledIn {
  kind: string;
  id: string;
  name: string;
  qty: number;
}

type Countable = { id: string; qty: number; approximate_qty?: number | null };

/** What a list row says about installation: how many are installed and in
 *  what, and how many are on hand (spare). A card's rows are each read; a
 *  record without rows is its own one row. A row inside a box or on a shelf
 *  is on hand; only a row inside an asset or machine is installed. */
export async function annotateInstalled<T extends Countable & { holdings?: Array<Countable> }>(
  orgId: string,
  items: T[],
): Promise<Array<T & { installed_qty: number; spare_qty: number; installed_in: InstalledIn[] }>> {
  const rowsOf = (it: T): Countable[] => (it.holdings && it.holdings.length ? it.holdings : [it]);
  const ids = [...new Set(items.flatMap((it) => rowsOf(it).map((r) => r.id)))];
  const where = await installedIn(orgId, PART, ids).catch(() => new Map());
  return items.map((it) => {
    const inside = new Map<string, InstalledIn>();
    let installed = 0;
    let spare = 0;
    for (const r of rowsOf(it)) {
      const n = Number(r.qty) || 0;
      const step = where.get(r.id);
      if (step) {
        installed += n;
        const key = `${step.kind}:${step.id}`;
        const cur = inside.get(key) ?? { kind: step.kind, id: step.id, name: step.name, qty: 0 };
        cur.qty += n;
        inside.set(key, cur);
      } else {
        // An estimate nobody counted (an assortment) is on hand all the same.
        spare += n > 0 ? n : Number(r.approximate_qty ?? 0) || 0;
      }
    }
    return { ...it, installed_qty: installed, spare_qty: spare, installed_in: [...inside.values()] };
  });
}
