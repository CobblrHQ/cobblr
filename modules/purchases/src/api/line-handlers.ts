// purchases:add-line — put a line on an existing order.
//
// draft-po creates an order with its lines and mark-arrived closes one, and
// between the two there was no way to say "add two more of those to the order I
// already raised". That is an ordinary thing to ask for.
//
// Removing a line has no door on purpose: an order is a financial record, and
// deleting a line by voice is the kind of thing you want to see before it
// happens. Editing the order in the app is one tap.

import { receiveIfArrived } from "../receive.js";
import { platform, requireActionEntity } from "@cobblr/platform-contract";
import { sql, type Kysely } from "kysely";
import type { PurchasesDB } from "../db.js";
import { claimLine } from "./line-subject.js";
import { editOrderLine, type LineEdit } from "../line-edit.js";

export function registerLineHandlers(): void {
  registerUndos();
  registerEditLine();
  registerRecordPaperwork();
  platform().actions.registerHandler("purchases.add-line", async (ctx) => {
    const order = requireActionEntity(ctx);
    const args = (ctx.args ?? {}) as Record<string, unknown>;
    const qty = typeof args.qty === "number" ? args.qty : Number(args.qty);
    if (!Number.isFinite(qty) || qty === 0) return { ok: false, error: "say how many (qty)" };

    const description = typeof args.description === "string" ? args.description.trim() : "";
    const partId = typeof args.part_id === "string" && args.part_id.trim() ? args.part_id.trim() : null;
    const forKind = typeof args.for_kind === "string" && args.for_kind.trim() ? args.for_kind.trim() : null;
    const forId = typeof args.for_id === "string" && args.for_id.trim() ? args.for_id.trim() : null;
    const subject = forKind && forId ? { kind: forKind, id: forId } : partId ? { kind: "inventory:part", id: partId } : null;
    if (!description && !subject) {
      return { ok: false, error: "say what the line is for: a description, or what it bought (part_id, or for_kind + for_id)" };
    }
    const unitCost = typeof args.unit_cost === "number" ? args.unit_cost : null;

    const db = (await platform().tenants.getDb(ctx.orgId)) as Kysely<PurchasesDB>;
    const exists = await db
      .selectFrom("purchases_orders")
      .select("id")
      .where("id", "=", order.id)
      .executeTakeFirst();
    if (!exists) return { ok: false, error: "that order no longer exists" };

    const row = await db
      .insertInto("purchases_order_items")
      .values({
        order_id: order.id,
        part_id: null,
        description: description || null,
        qty,
        unit_cost: unitCost,
        metadata: {},
      } as never)
      .returning(["id", "qty", "description"])
      .executeTakeFirstOrThrow();
    if (subject) await claimLine({ db, orgId: ctx.orgId, userId: ctx.userId ?? null, orderId: order.id, itemId: row.id, subject });
    // Added to an order that already arrived: it arrived with it.
    await receiveIfArrived(db, ctx.orgId, order.id, typeof args.add_to_stock === "boolean" ? args.add_to_stock : undefined);

    await platform().activity.log({
      orgId: ctx.orgId,
      userId: ctx.userId,
      action: "order_item_added",
      ref: { module: "purchases", entityType: "order_item", entityId: row.id },
      diff: { qty, description: description || null, part_id: partId },
    });
    return { ok: true, result: { line_id: row.id, qty: row.qty, description: row.description } };
  });
}

function registerEditLine(): void {
  // Correct one line: what it is, how many, the price. The same rule as the
  // order page (line-edit.ts): a line whose stock was already added keeps its
  // count.
  platform().actions.registerHandler("purchases.edit-line", async (ctx) => {
    const args = (ctx.args ?? {}) as Record<string, unknown>;
    const lineId = typeof args.line_id === "string" ? args.line_id.trim() : "";
    if (!lineId) return { ok: false, error: "say which line (line_id)" };
    const edit: LineEdit = {};
    if (typeof args.description === "string") edit.description = args.description.trim() || null;
    if (args.qty !== undefined) {
      const qty = Number(args.qty);
      if (!Number.isFinite(qty) || qty <= 0) return { ok: false, error: "how many must be more than 0 (qty)" };
      edit.qty = qty;
    }
    if (args.unit_cost !== undefined) edit.unit_cost = args.unit_cost === null ? null : Number(args.unit_cost);
    if (Object.keys(edit).length === 0) return { ok: false, error: "say what to change: description, qty or unit_cost" };
    const db = (await platform().tenants.getDb(ctx.orgId)) as Kysely<PurchasesDB>;
    // Scoped to the order it was run on, so a line id from another order is
    // refused rather than edited from here.
    const order = requireActionEntity(ctx);
    const r = await editOrderLine(db, { orgId: ctx.orgId, userId: ctx.userId ?? null }, lineId, edit, order.id);
    if (!r.ok) return { ok: false, error: r.message };
    // What it was, only for the fields this changed: the way back.
    const before = Object.fromEntries(Object.keys(edit).map((k) => [k, r.before[k as keyof typeof r.before]]));
    return { ok: true, result: { line_id: lineId, ...edit }, before };
  });
}

function registerUndos(): void {
  platform().actions.registerHandler("purchases.remove-line", async (ctx) => {
    const id = String((ctx.args as { line_id?: unknown } | null)?.line_id ?? "").trim();
    if (!id) return { ok: false, error: "missing line_id" };
    const db = (await platform().tenants.getDb(ctx.orgId)) as Kysely<PurchasesDB>;
    const row = await db.deleteFrom("purchases_order_items").where("id", "=", id).returning(["id", "description"]).executeTakeFirst();
    if (!row) return { ok: true, skipped: true, reason: "already gone" };
    return { ok: true, summary: `Removed the line${row.description ? ` for ${row.description}` : ""}.`, removed: row.id };
  });
  platform().actions.registerUndo("purchases.edit-line", (result) => {
    const r = result as { ok?: unknown; result?: { line_id?: unknown }; before?: Record<string, unknown> } | null;
    if (r?.ok !== true || typeof r.result?.line_id !== "string" || !r.before) return null;
    return { action_id: "purchases:edit-line", args: { line_id: r.result.line_id, ...r.before } };
  });
  platform().actions.registerUndo("purchases.add-line", (result) => {
    const r = result as { ok?: unknown; result?: { line_id?: unknown } } | null;
    if (r?.ok !== true || typeof r.result?.line_id !== "string") return null;
    return { action_id: "purchases:remove-line", args: { line_id: r.result.line_id } };
  });
}

// purchases:record-paperwork — a document put on a record (a bill of sale on a
// car) is a purchase: the order with every line as the paper printed it, each
// line marked for what it is (a charge, an add-on), and the line the paper is
// ABOUT claimed for that record, which also fills the record's Paid,
// Purchased at and Bought from from the order (claimLine). In-process, so the
// assistant's door reaches it exactly as the record's paste does (#4523).
interface PaperworkLine {
  description: string;
  qty: number;
  unit_cost: number | null;
  line_amount: number | null;
  kind?: "charge" | "add-on";
}
function registerRecordPaperwork(): void {
  platform().actions.registerHandler("purchases.record-paperwork", async (ctx) => {
    const args = (ctx.args ?? {}) as {
      vendor?: string | null;
      ordered_at?: string | null;
      order_ref?: string | null;
      total?: number | null;
      currency?: string | null;
      source_file_id?: string | null;
      lines?: PaperworkLine[];
      claim?: { index: number; kind: string; id: string } | null;
    };
    const lines = Array.isArray(args.lines) ? args.lines.filter((l) => l && typeof l.description === "string") : [];
    if (lines.length === 0) return { ok: false, error: "the paper has no lines to record" };
    const db = (await platform().tenants.getDb(ctx.orgId)) as Kysely<PurchasesDB>;
    const vendor = typeof args.vendor === "string" && args.vendor.trim() ? args.vendor.trim() : null;
    // The vendor as a managed record, found or made, the way an order typed
    // in the app links it.
    let vendorId: string | null = null;
    if (vendor) {
      const found = await db
        .selectFrom("purchases_vendors")
        .select("id")
        .where(sql<boolean>`lower(trim(name)) = ${vendor.toLowerCase()}`)
        .executeTakeFirst();
      vendorId = found?.id ?? (await db.insertInto("purchases_vendors").values({ name: vendor } as never).returning("id").executeTakeFirst())?.id ?? null;
    }
    const day = typeof args.ordered_at === "string" && /^\d{4}-\d{2}-\d{2}/.test(args.ordered_at) ? args.ordered_at.slice(0, 10) : null;
    const order = await db
      .insertInto("purchases_orders")
      .values({
        vendor,
        vendor_id: vendorId,
        order_number: args.order_ref ?? null,
        ordered_at: day,
        arrived_at: day,
        // The thing is already here: the paper is about something on hand.
        status: "arrived",
        // Nothing to count: the record it bought exists already.
        add_to_stock: false,
        total_cost: typeof args.total === "number" ? args.total : null,
        metadata: { currency: args.currency || undefined, ...(args.source_file_id ? { source_file_id: args.source_file_id } : {}), from_paperwork: true },
      } as never)
      .returning("id")
      .executeTakeFirstOrThrow();
    const lineIds: string[] = [];
    for (const l of lines) {
      const row = await db
        .insertInto("purchases_order_items")
        .values({
          order_id: order.id,
          part_id: null,
          description: l.description.slice(0, 300),
          qty: Number(l.qty) > 0 ? Number(l.qty) : 1,
          unit_cost: typeof l.unit_cost === "number" ? l.unit_cost : null,
          line_amount: typeof l.line_amount === "number" ? l.line_amount : null,
          metadata: { currency: args.currency || undefined, ...(l.kind ? { line_kind: l.kind } : {}) },
        } as never)
        .returning("id")
        .executeTakeFirstOrThrow();
      lineIds.push(row.id);
    }
    const claim = args.claim;
    const claimed = claim && lineIds[claim.index] ? lineIds[claim.index]! : null;
    if (claim && claimed) {
      await claimLine({ db, orgId: ctx.orgId, userId: ctx.userId ?? null, orderId: order.id, itemId: claimed, subject: { kind: claim.kind, id: claim.id } });
    }
    await platform().events.emit("purchases.order.created", { orgId: ctx.orgId, orderId: order.id });
    return { ok: true, summary: `Recorded the purchase${vendor ? ` from ${vendor}` : ""}, ${lines.length} line${lines.length === 1 ? "" : "s"}.`, order_id: order.id, line_ids: lineIds, claimed_line_id: claimed };
  });
}
