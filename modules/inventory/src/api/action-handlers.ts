// Action handlers — the wire-engine-callable + Tier-B-invokable side of
// inventory. All GENERIC inventory capabilities (a use-case lives in a bundle +
// its app, never here):
//   - inventory.adjust-stock — wire/HTTP stock mutation; re-emits stock.changed.
//   - inventory.set-status    — set a part's metadata.status.
//   - inventory.create-item   — create one item (name + fields + location/…).
//   - inventory.create-items  — bulk create N items in one INSERT; returns ids.
//   - inventory.update-item   — set name/brand/location + MERGE metadata fields.
// (The Lego kit→parts expansion that used to live here moved to the Lego domain
//  module, bricklink-connector — it drives create-items + update-item.)

import { sql, type Kysely } from "kysely";
import { platform } from "@cobblr/platform-contract";
import type { InventoryDB } from "../db.js";

let registered = false;

interface AdjustStockPayload {
  partId?: string;
  delta?: number;
  reason?: string;
}

export function registerInventoryActionHandlers(): void {
  if (registered) return;
  registered = true;

  platform().actions.registerHandler("inventory.adjust-stock", async (ctx) => {
    // Args take precedence (an admin can hardwire a wire to "always
    // add 1"); otherwise we pull from the event payload.
    const args = (ctx.args as AdjustStockPayload | null) ?? {};
    const ev = (ctx.event?.payload as AdjustStockPayload | null) ?? {};
    const partId = args.partId ?? ev.partId;
    const delta = args.delta ?? ev.delta;
    const reason = args.reason ?? ev.reason ?? "wire-driven adjustment";
    if (!partId || typeof delta !== "number" || delta === 0) {
      return { ok: true, skipped: true, reason: "missing partId or delta" };
    }
    const db = (await platform().tenants.getDb(ctx.orgId)) as Kysely<InventoryDB>;
    const updated = await db
      .updateTable("inventory_parts")
      .set({
        qty: sql<string>`qty + ${delta}::numeric`,
        updated_at: new Date(),
      })
      .where("id", "=", partId)
      .returning(["id", "name", "qty"])
      .executeTakeFirst();
    if (!updated) return { ok: false, error: "part_not_found" };
    // Re-emit the stock-changed event so the existing
    // wire-of-record (inventory.stock.changed → projects.set-dep-
    // satisfied) keeps working — this action is additive, not a
    // replacement for the direct HTTP stock-adjust.
    await platform().events.emit("inventory.stock.changed", {
      orgId: ctx.orgId,
      partId: updated.id,
      delta,
      newQty: Number(updated.qty),
      reason,
    });
    return {
      ok: true,
      partId: updated.id,
      delta,
      newQty: Number(updated.qty),
    };
  });

  // ─────────────────────── set-status ──────────────────────────────
  // A small, member-appropriate write: set a part's metadata.status
  // (the Lego set Built/Unbuilt/Missing-pieces field). This is the
  // canonical action a custom (Tier B) app block invokes — capability
  // -gated (`inventory:set-status`) like any other, so a worker can only
  // run it if granted. partId comes from args or the targeted entity.
  platform().actions.registerHandler("inventory.set-status", async (ctx) => {
    const args = (ctx.args as { partId?: string; status?: string } | null) ?? {};
    const partId = args.partId ?? (ctx.entity as { id?: string } | null)?.id;
    const status = typeof args.status === "string" ? args.status.trim().slice(0, 60) : undefined;
    if (!partId || !status) return { ok: false, error: "missing partId or status" };
    const db = (await platform().tenants.getDb(ctx.orgId)) as Kysely<InventoryDB>;
    const row = await db
      .selectFrom("inventory_parts")
      .select(["metadata"])
      .where("id", "=", partId)
      .executeTakeFirst();
    if (!row) return { ok: false, error: "part_not_found" };
    const existing = (row.metadata as Record<string, unknown> | null) ?? {};
    await db
      .updateTable("inventory_parts")
      .set({
        metadata: sql`${JSON.stringify({ ...existing, status })}::jsonb` as never,
        updated_at: new Date(),
      })
      .where("id", "=", partId)
      .execute();
    return { ok: true, partId, status };
  });

  // ─────────────────────── create-item ─────────────────────────────
  // Generic item creation — the canonical write a custom (Tier B) app block
  // performs when it needs to ADD an entity (there was no invokable create
  // action before; apps could only set-status / adjust-stock). Creates an
  // inventory item in a given instance with a name + custom fields (metadata)
  // + an optional location/manufacturer/qty. Knows nothing about any specific
  // use-case — the caller composes the name + fields and decides what to make.
  // Capability-gated (`inventory:create-item`). Emits inventory.part.created so
  // wires fire as they would for an HTTP create.
  platform().actions.registerHandler("inventory.create-item", async (ctx) => {
    const a = (ctx.args as Record<string, unknown> | null) ?? {};
    // Empty → undefined so the column DEFAULT ('inventory') applies (see
    // create-items); "" would hide the row in an unreadable instance.
    const instance = typeof a.instance === "string" && a.instance.trim() ? a.instance.trim() : undefined;
    const name = typeof a.name === "string" && a.name.trim() ? a.name.trim().slice(0, 200) : "Untitled";
    const manufacturer = typeof a.manufacturer === "string" && a.manufacturer.trim() ? a.manufacturer.trim().slice(0, 120) : null;
    const locationId = typeof a.location_id === "string" && a.location_id ? a.location_id : null;
    const fields = (a.fields && typeof a.fields === "object" ? a.fields : {}) as Record<string, unknown>;
    const qty = typeof a.qty === "number" ? String(a.qty) : "1";
    const unit = typeof a.unit === "string" && a.unit.trim() ? a.unit.trim().slice(0, 30) : "each";

    const db = (await platform().tenants.getDb(ctx.orgId)) as Kysely<InventoryDB>;
    const created = await db
      .insertInto("inventory_parts")
      .values({
        name,
        qty,
        unit,
        instance,
        location_id: locationId,
        manufacturer,
        metadata: sql`${JSON.stringify(fields)}::jsonb` as never,
      })
      .returning(["id", "name"])
      .executeTakeFirst();
    if (!created) return { ok: false, error: "create_failed" };

    await platform().events.emit("inventory.part.created", { orgId: ctx.orgId, partId: created.id });
    return { ok: true, item_id: created.id, name: created.name };
  });

  // ─────────────────────── create-items (bulk) ─────────────────────
  // Generic bulk create — one INSERT for N items (a kit BOM, a CSV import, a
  // batch from another module). Returns the new ids in input order so the
  // caller can wire pairings. Deliberately does NOT fan out per-item
  // inventory.part.created events (a 700-part expansion shouldn't fire 700
  // wires); a caller that needs a signal emits its own. Generic — no use-case.
  platform().actions.registerHandler("inventory.create-items", async (ctx) => {
    const a = (ctx.args as Record<string, unknown> | null) ?? {};
    const items = Array.isArray(a.items) ? (a.items as Record<string, unknown>[]) : [];
    if (items.length === 0) return { ok: true, ids: [] };
    const db = (await platform().tenants.getDb(ctx.orgId)) as Kysely<InventoryDB>;
    const rows = items.map((o) => ({
      name: typeof o.name === "string" && o.name.trim() ? o.name.trim().slice(0, 200) : "Untitled",
      qty: typeof o.qty === "number" ? String(o.qty) : typeof o.qty === "string" && o.qty ? o.qty : "1",
      unit: typeof o.unit === "string" && o.unit.trim() ? o.unit.trim().slice(0, 30) : "each",
      // Omit when not given so the column DEFAULT ('inventory') applies —
      // forcing "" would bury the rows in an empty instance the default
      // list/detail reads (instanceOf → 'inventory') never return.
      instance: typeof o.instance === "string" && o.instance.trim() ? o.instance.trim() : undefined,
      location_id: typeof o.location_id === "string" && o.location_id ? o.location_id : null,
      manufacturer: typeof o.manufacturer === "string" && o.manufacturer.trim() ? o.manufacturer.trim().slice(0, 120) : null,
      image_path: typeof o.image_path === "string" && o.image_path ? o.image_path : null,
      metadata: sql`${JSON.stringify(o.fields && typeof o.fields === "object" ? o.fields : {})}::jsonb` as never,
    }));
    const inserted = await db.insertInto("inventory_parts").values(rows).returning(["id"]).execute();
    return { ok: true, ids: inserted.map((r) => r.id) };
  });

  // ─────────────────────── update-item ─────────────────────────────
  // Generic field update — set a part's name / brand / location and/or MERGE
  // metadata fields (e.g. mark a kit metadata.lifecycle='parted-out'). The
  // companion to create-item; lets a Tier-B app or another module edit an item
  // through inventory's public interface instead of touching the table. Generic.
  platform().actions.registerHandler("inventory.update-item", async (ctx) => {
    const a = (ctx.args as Record<string, unknown> | null) ?? {};
    const id = typeof a.id === "string" && a.id ? a.id : (ctx.entity as { id?: string } | null)?.id;
    if (!id) return { ok: false, error: "missing id" };
    const db = (await platform().tenants.getDb(ctx.orgId)) as Kysely<InventoryDB>;
    const row = await db.selectFrom("inventory_parts").select("metadata").where("id", "=", id).executeTakeFirst();
    if (!row) return { ok: false, error: "not_found" };
    const set: Record<string, unknown> = { updated_at: new Date() };
    if (typeof a.name === "string" && a.name.trim()) set.name = a.name.trim().slice(0, 200);
    if (typeof a.manufacturer === "string") set.manufacturer = a.manufacturer.trim().slice(0, 120) || null;
    if (typeof a.location_id === "string") set.location_id = a.location_id || null;
    if (a.fields && typeof a.fields === "object") {
      const existing = (row.metadata as Record<string, unknown> | null) ?? {};
      set.metadata = sql`${JSON.stringify({ ...existing, ...(a.fields as Record<string, unknown>) })}::jsonb` as never;
    }
    await db.updateTable("inventory_parts").set(set as never).where("id", "=", id).execute();
    await platform().events.emit("inventory.part.updated", { orgId: ctx.orgId, partId: id });
    return { ok: true, id };
  });
}

