// One-shot heal: an order that lists each receipt line twice keeps one.
//
// DONE WHEN: no tenant DB has a purchases_order_items pair on one order with
// the same (description, qty) where one row has part_id NULL and another has
// a part. Check with, per tenant:
//   select a.order_id, a.description, a.qty
//     from purchases_order_items a join purchases_order_items b
//       on a.order_id = b.order_id and a.id <> b.id
//      and a.description is not distinct from b.description and a.qty = b.qty
//    where a.part_id is null and b.part_id is not null;
// When that is empty on prod, staging and dev AND a stable release has shipped
// with this file in it (2026.10.0, so an install that jumps from 2026.8.1 runs
// it, #7679), delete this file and its boot call. Nothing re-creates the
// shape: confirm claims a line now instead of adding one, and the inbox panel
// that added them is gone.
//
// BORN WITH: confirm claims a line instead of adding one (018ae49785), so no
// new order is made twice; this heals the ones 2026.8.1 and the builds up to
// 2026-09-06 made.
//
// WHY IT EXISTS: from 2026-08-16 a receipt's order was born at parse with one
// line per item, part_id NULL. The inbox's "confirm as purchase order" panel
// kept doing what it did before that - ADD a line per item, with the part - so
// every order confirmed through it carried each line twice: "Croissant qty 2"
// with no part, and "Croissant qty 2" with one (measured 2026-09-06). The
// order said you bought twice what the receipt did. This drops the part-less
// twin and keeps the one the inventory item points at, which is also the one
// the inbox row's undo knows by id.
import { Kysely } from "kysely";
import { registerHealPass } from "@cobblr/platform-contract/heal-pass";

interface HealDB {
  purchases_order_items: {
    id: string;
    order_id: string;
    part_id: string | null;
    description: string | null;
    qty: unknown;
    created_at: Date;
  };
}

export interface LineLite {
  id: string;
  order_id: string;
  part_id: string | null;
  description: string | null;
  qty: unknown;
}

/**
 * The part-less twins to drop: for each (order, description, qty) that has both
 * a NULL-part line and a part-bearing line, every NULL-part line goes. Pure,
 * so the rule is tested without a database; the boot wrapper only feeds it.
 *
 * A group with only NULL lines is a receipt nobody filed - untouched. A group
 * with only part lines is a plain order - untouched. Only the doubled shape
 * moves, and only its part-less half.
 */
export function doubledLinesToDrop(lines: LineLite[]): string[] {
  const groups = new Map<string, LineLite[]>();
  for (const l of lines) {
    const key = `${l.order_id}|${(l.description ?? "").trim().toLowerCase()}|${String(l.qty)}`;
    const g = groups.get(key) ?? [];
    g.push(l);
    groups.set(key, g);
  }
  const drop: string[] = [];
  for (const g of groups.values()) {
    const withPart = g.some((l) => l.part_id);
    if (!withPart) continue;
    for (const l of g) if (!l.part_id) drop.push(l.id);
  }
  return drop;
}

/** Heal one workspace; answers how many doubled lines it found. */
export async function healDoubledReceiptLinesIn(orgId: string, db: Kysely<HealDB>, since: Date): Promise<number> {
  // Cheap on the happy path: only orders that have at least one part-less
  // line AND at least one part-bearing line are read at all.
  const candidates = await db
    .selectFrom("purchases_order_items as a")
    .select("a.order_id")
    .distinct()
    .where("a.part_id", "is", null)
    .where("a.created_at", "<", since)
    .where((eb) =>
      eb.exists(
        eb
          .selectFrom("purchases_order_items as b")
          .select("b.id")
          .whereRef("b.order_id", "=", "a.order_id")
          .where("b.part_id", "is not", null),
      ),
    )
    .execute();
  if (candidates.length === 0) return 0;
  const lines = await db
    .selectFrom("purchases_order_items")
    .select(["id", "order_id", "part_id", "description", "qty"])
    .where("order_id", "in", candidates.map((c) => c.order_id))
    .where("created_at", "<", since)
    .execute();
  const drop = doubledLinesToDrop(lines as LineLite[]);
  if (drop.length === 0) return 0;
  const r = await db.deleteFrom("purchases_order_items").where("id", "in", drop).executeTakeFirst();
  const n = Number(r.numDeletedRows ?? 0);
  if (n > 0) console.log(`[purchases] org ${orgId}: dropped ${n} doubled receipt line(s) across ${candidates.length} order(s)`);
  return drop.length;
}

/** Call from onBoot. A registered pass (platform-contract heal-pass.ts): the
 *  kernel's walk, budget and stagger, never a walk of its own at boot. */
export function registerDoubledReceiptLinesHeal(): void {
  registerHealPass({
    name: "purchases.heal-doubled-receipt-lines",
    shim: "modules/purchases/src/heal-doubled-receipt-lines.ts",
    module: "purchases",
    // The fix that stopped it: filing a receipt line claims its order line (018ae49785).
    since: "2026-09-06T20:18:23Z",
    visit: ({ orgId, db, since }) => healDoubledReceiptLinesIn(orgId, db as Kysely<HealDB>, since),
  });
}
