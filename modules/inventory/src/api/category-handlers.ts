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
}
