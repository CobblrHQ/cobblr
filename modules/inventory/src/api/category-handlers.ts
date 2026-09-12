// inventory:add-category — a category is a plain named row, and the assistant
// had no way to add one.
//
// Deliberately narrow. Inventory already has twelve actions covering stock
// movement, and ALLOCATIONS stay out for now: consuming a reservation moves
// stock AND writes a ledger withdrawal in one transaction, and the route's
// error branches are interleaved with its HTTP responses, so giving it a door
// means refactoring that transaction rather than moving it. A second copy of
// stock-moving code is how a running balance comes to disagree with reality,
// so it waits for a proper extraction with a test.

import { platform } from "@cobblr/platform-contract";
import type { Kysely } from "kysely";
import type { InventoryDB } from "../db.js";

export function registerCategoryHandlers(): void {
  platform().actions.registerHandler("inventory.add-category", async (ctx) => {
    const args = (ctx.args ?? {}) as Record<string, unknown>;
    const name = typeof args.name === "string" ? args.name.trim() : "";
    if (!name) return { ok: false, error: "say what the category is called" };
    if (name.length > 120) return { ok: false, error: "that name is too long (120 characters max)" };

    const color = typeof args.color === "string" && /^#[0-9a-fA-F]{3,8}$/.test(args.color.trim())
      ? args.color.trim()
      : null;

    const db = (await platform().tenants.getDb(ctx.orgId)) as Kysely<InventoryDB>;
    const existing = await db
      .selectFrom("inventory_categories")
      .select(["id", "name"])
      .where("name", "=", name)
      .executeTakeFirst();
    // Asking for one that exists is not a failure worth alarming anyone about.
    if (existing) return { ok: true, result: { id: existing.id, name: existing.name, existed: true } };

    const row = await db
      .insertInto("inventory_categories")
      .values({ name, color } as never)
      .returning(["id", "name"])
      .executeTakeFirstOrThrow();
    return { ok: true, result: { id: row.id, name: row.name, existed: false } };
  });

  // One that already existed was left as it was; one this run made is removed
  // again, unless something has been filed under it since.
  platform().actions.registerUndo("inventory.add-category", (result) => {
    const r = (result as { result?: { id?: unknown; existed?: unknown } } | null)?.result;
    if (typeof r?.id !== "string" || r.existed) return null;
    return { action_id: "inventory:remove-category", args: { category_id: r.id } };
  });
  platform().actions.registerHandler("inventory.remove-category", async (ctx) => {
    const id = String((ctx.args as { category_id?: unknown } | null)?.category_id ?? "").trim();
    if (!id) return { ok: false, error: "missing category_id" };
    const db = (await platform().tenants.getDb(ctx.orgId)) as Kysely<InventoryDB>;
    const used = await db.selectFrom("inventory_parts").select("id").where("category_id", "=", id).limit(1).executeTakeFirst();
    if (used) return { ok: false, error: "that category has things filed under it now, so it stays" };
    const row = await db.deleteFrom("inventory_categories").where("id", "=", id).returning(["id", "name"]).executeTakeFirst();
    if (!row) return { ok: false, error: `no category with id ${id}` };
    return { ok: true, summary: `Removed the ${row.name} category.`, result: { id: row.id, name: row.name } };
  });
  platform().actions.registerUndo("inventory.remove-category", (result) => {
    const r = (result as { result?: { name?: unknown } } | null)?.result;
    if (typeof r?.name !== "string") return null;
    return { action_id: "inventory:add-category", args: { name: r.name } };
  });
}
