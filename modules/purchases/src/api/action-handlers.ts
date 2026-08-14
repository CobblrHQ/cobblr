// purchases action handlers. `purchases:draft-po` is the wire target that
// makes "stock that reorders itself" real: when a part runs low (or a user
// taps the button), a DRAFT purchase order lands for the part's USUAL vendor
// at the USUAL quantity — derived from the part's own purchase history, no
// per-part configuration. The human stays in the loop: a draft is
// status:"planned"; approving it (planned → ordered) is the existing orders
// flow, and the existing arrival wire restocks on receipt.
//
// Module-ignorance note: this handler knows `inventory:part` only as an
// entity-kind ID resolved through platform() seams (lookup for the title,
// its own purchases_order_items.part_id for history) — it never touches
// inventory's tables or imports its code.

import { sql, type Kysely } from "kysely";
import { platform } from "@cobblr/platform-contract";
import type { OrderStatus, PurchasesDB } from "../db.js";

let registered = false;

interface DraftPoArgs {
  /** Explicit part — else from the wire's entity / the event payload. */
  partId?: string;
  /** Override the derived quantity. */
  qty?: number;
  /** Override the derived vendor (purchases_vendors.id). */
  vendorId?: string;
}

interface StockLowPayload {
  partId?: string;
  newQty?: number;
  minQty?: number;
}

/** Order statuses that count as "already on its way" — a part with an
 *  un-received line on one of these must not be re-drafted every time
 *  another low-stock event fires. */
const OPEN_STATUSES: OrderStatus[] = ["planned", "ordered", "in-transit"];

export function registerPurchasesActionHandlers(): void {
  if (registered) return;
  registered = true;

  platform().actions.registerHandler("purchases.draft-po", async (ctx) => {
    const args = (ctx.args as DraftPoArgs | null) ?? {};
    const ev = (ctx.event?.payload as StockLowPayload | null) ?? {};
    // The action's appliesTo predicate (manifest) already guarantees a
    // user-invoked entity IS a part — no kind branch here (module-isolation
    // lint D-module-names-module: naming foreign kinds belongs in the
    // manifest declaration, not handler logic).
    const partId = args.partId ?? ev.partId ?? (ctx.entity?.id || undefined);
    if (!partId) return { ok: true, skipped: "no part in scope" };

    const db = (await platform().tenants.getDb(ctx.orgId)) as Kysely<PurchasesDB>;

    // 1. Idempotence: if an un-received line for this part already sits on an
    //    open order, the reorder is in flight — don't pile up drafts on every
    //    subsequent decrement below min.
    const inFlight = await db
      .selectFrom("purchases_order_items as i")
      .innerJoin("purchases_orders as o", "o.id", "i.order_id")
      .select("i.id")
      .where("i.part_id", "=", partId)
      .where("i.received_at", "is", null)
      .where("o.status", "in", OPEN_STATUSES)
      .executeTakeFirst();
    if (inFlight) return { ok: true, skipped: "already on an open order" };

    // 2. The USUAL vendor + quantity + cost: the part's most recent purchase
    //    line. History-derived, so it needs zero per-part setup and tracks
    //    reality (switch vendors once and the next draft follows you).
    const usual = await db
      .selectFrom("purchases_order_items as i")
      .innerJoin("purchases_orders as o", "o.id", "i.order_id")
      .select(["i.qty", "i.unit_cost", "i.description", "o.vendor", "o.vendor_id"])
      .where("i.part_id", "=", partId)
      .orderBy("i.created_at", "desc")
      .limit(1)
      .executeTakeFirst();

    // Explicit vendor override wins; else history; else a vendorless draft
    // (the human picks a vendor when approving — still beats forgetting).
    let vendor: string | null = usual?.vendor ?? null;
    let vendorId: string | null = usual?.vendor_id ?? null;
    if (args.vendorId) {
      const v = await db
        .selectFrom("purchases_vendors")
        .select(["id", "name"])
        .where("id", "=", args.vendorId)
        .executeTakeFirst();
      if (v) {
        vendorId = v.id;
        vendor = v.name;
      }
    }
    const qty = args.qty ?? (usual ? Number(usual.qty) : null) ?? (ev.minQty && ev.minQty > 0 ? ev.minQty : 1);

    // The part's display name for the line description (kernel resolver —
    // no reach into inventory's tables).
    const resolved = await platform()
      .entities.lookup(ctx.orgId, "inventory:part", partId)
      .catch(() => null);
    const description = resolved?.title ?? usual?.description ?? "Reorder";

    // 3. One draft per vendor: append to an existing PLANNED order for this
    //    vendor (or the vendorless draft) so a bad week yields one tidy PO,
    //    not ten. Else create the draft.
    let order = await db
      .selectFrom("purchases_orders")
      .select(["id", "vendor"])
      .where("status", "=", "planned")
      .where((eb) => (vendorId ? eb("vendor_id", "=", vendorId) : eb("vendor_id", "is", null)))
      .where(sql<boolean>`coalesce(metadata->>'auto_drafted', '') = 'true'`)
      .orderBy("created_at", "desc")
      .executeTakeFirst();
    let created = false;
    if (!order) {
      order = await db
        .insertInto("purchases_orders")
        .values({
          vendor,
          vendor_id: vendorId,
          status: "planned",
          notes: "Auto-drafted by the low-stock wire. Review the lines, then mark it ordered.",
          metadata: { auto_drafted: true },
        })
        .returning(["id", "vendor"])
        .executeTakeFirstOrThrow();
      created = true;
    }

    const item = await db
      .insertInto("purchases_order_items")
      .values({
        order_id: order.id,
        part_id: partId,
        description,
        qty,
        unit_cost: usual?.unit_cost != null ? Number(usual.unit_cost) : null,
        metadata: { auto_drafted: true, low_stock_qty: ev.newQty ?? null },
      })
      .returning("id")
      .executeTakeFirstOrThrow();

    if (created) {
      await platform().events.emit("purchases.order.created", {
        orgId: ctx.orgId,
        orderId: order.id,
      });
    }
    return {
      ok: true,
      order_id: order.id,
      item_id: item.id,
      vendor: vendor ?? "(pick a vendor when approving)",
      qty,
      created_order: created,
    };
  });

  // The answer to the arrival sweep's question, in one tap.
  //
  // Setting status to 'arrived' is what the existing PATCH already does, and
  // what emits purchases.order.arrived plus one order_item.received per mapped
  // line — the wire that bumps stock. This exists so the answer is a BUTTON on
  // the order (and something an agent can invoke) rather than a status dropdown
  // plus a date picker, because it is asked of people who were interrupted to
  // answer it.
  platform().actions.registerHandler("purchases.mark-arrived", async (ctx) => {
    const args = (ctx.args as { orderId?: string; arrivedOn?: string } | null) ?? {};
    const orderId = args.orderId ?? (ctx.entity?.id || undefined);
    if (!orderId) return { ok: true, skipped: "no order in scope" };

    const db = (await platform().tenants.getDb(ctx.orgId)) as Kysely<PurchasesDB>;
    const before = await db
      .selectFrom("purchases_orders")
      .select(["id", "status", "arrived_at"])
      .where("id", "=", orderId)
      .executeTakeFirst();
    if (!before) return { ok: false, error: "order not found" };
    // Idempotent: answering twice (two devices, or a stale notification) must
    // not re-emit the arrival and double-bump stock.
    if (before.status === "arrived") return { ok: true, skipped: "already arrived" };

    const arrivedOn = args.arrivedOn ?? new Date().toISOString().slice(0, 10);
    await db
      .updateTable("purchases_orders")
      .set({ status: "arrived" as OrderStatus, arrived_at: arrivedOn, updated_at: new Date() } as never)
      .where("id", "=", orderId)
      .execute();

    await platform().events.emit("purchases.order.status_changed", {
      orgId: ctx.orgId,
      orderId,
      from: before.status,
      to: "arrived",
    });
    await platform().events.emit("purchases.order.arrived", { orgId: ctx.orgId, orderId });

    // Same fan-out as the PATCH path: one event per line mapped to a part, so
    // the stock-bump wire has something to bind to.
    const items = await db
      .selectFrom("purchases_order_items")
      .select(["id", "part_id", "qty", "unit_cost", "description"])
      .where("order_id", "=", orderId)
      .where("part_id", "is not", null)
      .execute();
    for (const it of items) {
      if (!it.part_id) continue;
      await platform().events.emit("purchases.order_item.received", {
        orgId: ctx.orgId,
        orderId,
        orderItemId: it.id,
        partId: it.part_id,
        qty: Number(it.qty),
        unitCost: it.unit_cost == null ? null : Number(it.unit_cost),
        description: it.description,
      });
    }

    return { ok: true, order_id: orderId, arrived_at: arrivedOn, lines_received: items.length };
  });
}
