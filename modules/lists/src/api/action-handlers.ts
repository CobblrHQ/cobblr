// lists action handlers. `lists:add-item` is the wire target that
// lets ANY event auto-append to a list — the integration that makes
// "inventory.stock.low → shopping list" (and expiry → shopping list) work.
//
// The handler resolves WHICH list to add to and WHAT to add from the wire's
// args + the triggering event payload, and DEDUPES by title within the list so
// repeated low-stock events don't pile up duplicates. It resolves the source
// entity's title via platform().entities.lookup() so the wire doesn't need to
// hard-code the item name.

import { sql, type Kysely } from "kysely";
import { platform, requireActionEntity } from "@cobblr/platform-contract";
import type { ListsDB } from "../db.js";

let registered = false;

interface AddItemArgs {
  /** Target list — by id (preferred) or by exact title (created if missing). */
  listId?: string;
  listTitle?: string;
  /** Explicit item title; else derived from the source entity. */
  title?: string;
  qty?: string;
  note?: string;
}

export function registerListActionHandlers(): void {
  if (registered) return;
  registered = true;

  platform().actions.registerHandler("lists.add-item", async (ctx) => {
    const args = (ctx.args as AddItemArgs | null) ?? {};
    const db = (await platform().tenants.getDb(ctx.orgId)) as Kysely<ListsDB>;

    // 1. Resolve the title — explicit arg, else the source entity's title.
    let title = args.title?.trim();
    if (!title && ctx.entityKind && ctx.entityId) {
      const resolved = await platform().entities.lookup(ctx.orgId, ctx.entityKind, ctx.entityId).catch(() => null);
      title = resolved?.title?.trim();
    }
    if (!title) return { ok: true, skipped: "no title to add" };

    // 2. Resolve the target list — id, or by title (create-on-miss so a fresh
    //    workspace's first low-stock event still has somewhere to go).
    let listId = args.listId;
    if (!listId) {
      const wantTitle = (args.listTitle ?? "Shopping list").trim();
      const existing = await db
        .selectFrom("lists_lists")
        .select("id")
        .where(sql<boolean>`lower(title) = lower(${wantTitle})`)
        .executeTakeFirst();
      listId = existing?.id ?? (await db.insertInto("lists_lists").values({ title: wantTitle }).returning("id").executeTakeFirstOrThrow()).id;
    }

    // 3. Dedupe: skip if an OPEN item with the same title already exists.
    const dup = await db
      .selectFrom("lists_items")
      .select("id")
      .where("list_id", "=", listId)
      .where("checked", "=", false)
      .where(sql<boolean>`lower(title) = lower(${title})`)
      .executeTakeFirst();
    if (dup) return { ok: true, skipped: "already on the list", itemId: dup.id };

    // Carry a back-pointer to the entity that spawned this line (the
    // inventory part that ran low / is expiring). Generic — `source_ref` can
    // point at any kind — so lists never learns what inventory is. It's
    // what lets checking the item off close the loop back to stock (see the
    // food-cluster `item.checked → inventory:adjust-stock` wire).
    const metadata =
      ctx.entityKind && ctx.entityId ? { source_ref: { kind: ctx.entityKind, id: ctx.entityId } } : {};
    const row = await db
      .insertInto("lists_items")
      .values({ list_id: listId, title, qty: args.qty ?? null, note: args.note ?? null, metadata: sql`${JSON.stringify(metadata)}::jsonb` as never })
      .returning(["id", "list_id"])
      .executeTakeFirstOrThrow();
    void platform().events.emit("lists.item.added", { orgId: ctx.orgId, listId: row.list_id, itemId: row.id, viaWire: true });
    return { ok: true, added: true, itemId: row.id, listId };
  });

  // Clearing the ticked items had no door: add-item was the module's only
  // action, so the assistant could fill a list and never tidy it.
  platform().actions.registerHandler("lists.clear-done", async (ctx) => {
    const entity = requireActionEntity(ctx);
    const db = (await platform().tenants.getDb(ctx.orgId)) as Kysely<ListsDB>;
    const res = await db
      .deleteFrom("lists_items")
      .where("list_id", "=", entity.id)
      .where("checked", "=", true)
      .executeTakeFirst();
    const removed = Number(res.numDeletedRows ?? 0n);
    return {
      ok: true,
      result: {
        removed,
        note: removed ? `Cleared ${removed} done item(s).` : "Nothing was ticked off.",
      },
    };
  });
}
