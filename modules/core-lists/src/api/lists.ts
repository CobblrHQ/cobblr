// core-lists CRUD — lists + their items. Mounted at
//   /api/v1/orgs/:slug/modules/core-lists/
// Routes:
//   GET    /lists                 list all lists (+ open item counts)
//   POST   /lists                 create a list
//   GET    /lists/:id             one list + its items
//   PATCH  /lists/:id             rename / edit a list
//   DELETE /lists/:id             delete a list (cascades items)
//   POST   /lists/:id/clear-done  remove all checked items (the "clear done" sweep)
//   POST   /items                 add an item (body.list_id)
//   PATCH  /items/:id             toggle checked / edit
//   DELETE /items/:id             remove an item

import { Router } from "express";
import { sql } from "kysely";
import { platform } from "@cobblr/platform-contract";
import { z } from "zod";
import { tenantContext, tenantDb, sessionUser } from "../db.js";
import { asyncHandler, badBody, requireRole } from "./util.js";

export const listsRouter = Router({ mergeParams: true });

const jsonb = (v: unknown) => sql`${JSON.stringify(v ?? {})}::jsonb`;
const ROLES = ["owner", "admin", "member"] as const;

// ── lists ───────────────────────────────────────────────────────────────────
const ListCreate = z.object({
  title: z.string().min(1).max(200),
  description: z.string().max(2000).optional(),
  metadata: z.record(z.unknown()).optional(),
});
const ListUpdate = ListCreate.partial();

listsRouter.get(
  "/lists",
  asyncHandler(async (req, res) => {
    if (!requireRole(req, res, ...ROLES)) return;
    const db = tenantDb(req);
    const lists = await db.selectFrom("core_lists_lists").selectAll().orderBy("created_at", "desc").execute();
    // open-item counts in one grouped query
    const counts = await db
      .selectFrom("core_lists_items")
      .select(["list_id", (eb) => eb.fn.countAll().as("total"), (eb) => eb.fn.sum(eb.case().when("checked", "=", true).then(1).else(0).end()).as("done")])
      .groupBy("list_id")
      .execute();
    const byList = new Map(counts.map((c) => [c.list_id, c]));
    res.json({
      items: lists.map((l) => {
        const c = byList.get(l.id);
        const total = Number(c?.total ?? 0);
        const done = Number(c?.done ?? 0);
        return { ...l, item_count: total, open_count: total - done, done_count: done };
      }),
    });
  }),
);

listsRouter.post(
  "/lists",
  asyncHandler(async (req, res) => {
    if (!requireRole(req, res, ...ROLES)) return;
    const parsed = ListCreate.safeParse(req.body);
    if (!parsed.success) return badBody(res, parsed.error);
    const db = tenantDb(req);
    const ctx = tenantContext(req);
    const row = await db
      .insertInto("core_lists_lists")
      .values({
        title: parsed.data.title,
        description: parsed.data.description ?? null,
        metadata: jsonb(parsed.data.metadata) as never,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    void platform().events.emit("core-lists.list.created", { orgId: ctx.org.id, listId: row.id });
    res.status(201).json(row);
  }),
);

listsRouter.get(
  "/lists/:id",
  asyncHandler(async (req, res) => {
    if (!requireRole(req, res, ...ROLES)) return;
    const db = tenantDb(req);
    const list = await db.selectFrom("core_lists_lists").selectAll().where("id", "=", req.params.id!).executeTakeFirst();
    if (!list) return void res.status(404).json({ error: { code: "not_found", message: "List not found." } });
    const items = await db
      .selectFrom("core_lists_items")
      .selectAll()
      .where("list_id", "=", req.params.id!)
      // open items first, then by creation; checked sink to the bottom
      .orderBy("checked", "asc")
      .orderBy("created_at", "asc")
      .execute();
    res.json({ ...list, items });
  }),
);

listsRouter.patch(
  "/lists/:id",
  asyncHandler(async (req, res) => {
    if (!requireRole(req, res, ...ROLES)) return;
    const parsed = ListUpdate.safeParse(req.body);
    if (!parsed.success) return badBody(res, parsed.error);
    const db = tenantDb(req);
    const patch: Record<string, unknown> = { updated_at: new Date() };
    if (parsed.data.title !== undefined) patch.title = parsed.data.title;
    if (parsed.data.description !== undefined) patch.description = parsed.data.description;
    if (parsed.data.metadata !== undefined) patch.metadata = jsonb(parsed.data.metadata);
    const row = await db.updateTable("core_lists_lists").set(patch).where("id", "=", req.params.id!).returningAll().executeTakeFirst();
    if (!row) return void res.status(404).json({ error: { code: "not_found", message: "List not found." } });
    res.json(row);
  }),
);

listsRouter.delete(
  "/lists/:id",
  asyncHandler(async (req, res) => {
    if (!requireRole(req, res, "owner", "admin")) return;
    const db = tenantDb(req);
    const ctx = tenantContext(req);
    await db.deleteFrom("core_lists_lists").where("id", "=", req.params.id!).execute();
    void platform().events.emit("core-lists.list.deleted", { orgId: ctx.org.id, listId: req.params.id });
    res.status(204).end();
  }),
);

listsRouter.post(
  "/lists/:id/clear-done",
  asyncHandler(async (req, res) => {
    if (!requireRole(req, res, ...ROLES)) return;
    const db = tenantDb(req);
    const r = await db.deleteFrom("core_lists_items").where("list_id", "=", req.params.id!).where("checked", "=", true).executeTakeFirst();
    res.json({ cleared: Number(r.numDeletedRows ?? 0) });
  }),
);

// ── items ───────────────────────────────────────────────────────────────────
const ItemCreate = z.object({
  list_id: z.string().uuid(),
  title: z.string().min(1).max(300),
  note: z.string().max(2000).optional(),
  qty: z.string().max(64).optional(),
  metadata: z.record(z.unknown()).optional(),
});
const ItemUpdate = z.object({
  title: z.string().min(1).max(300).optional(),
  note: z.string().max(2000).optional(),
  qty: z.string().max(64).optional(),
  checked: z.boolean().optional(),
  metadata: z.record(z.unknown()).optional(),
});

listsRouter.post(
  "/items",
  asyncHandler(async (req, res) => {
    if (!requireRole(req, res, ...ROLES)) return;
    const parsed = ItemCreate.safeParse(req.body);
    if (!parsed.success) return badBody(res, parsed.error);
    const db = tenantDb(req);
    const ctx = tenantContext(req);
    // the list must exist (and scopes to this tenant DB)
    const list = await db.selectFrom("core_lists_lists").select("id").where("id", "=", parsed.data.list_id).executeTakeFirst();
    if (!list) return void res.status(404).json({ error: { code: "not_found", message: "List not found." } });
    const row = await db
      .insertInto("core_lists_items")
      .values({
        list_id: parsed.data.list_id,
        title: parsed.data.title,
        note: parsed.data.note ?? null,
        qty: parsed.data.qty ?? null,
        metadata: jsonb(parsed.data.metadata) as never,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    void platform().events.emit("core-lists.item.added", { orgId: ctx.org.id, listId: row.list_id, itemId: row.id });
    res.status(201).json(row);
  }),
);

listsRouter.patch(
  "/items/:id",
  asyncHandler(async (req, res) => {
    if (!requireRole(req, res, ...ROLES)) return;
    const parsed = ItemUpdate.safeParse(req.body);
    if (!parsed.success) return badBody(res, parsed.error);
    const db = tenantDb(req);
    const ctx = tenantContext(req);
    const patch: Record<string, unknown> = { updated_at: new Date() };
    if (parsed.data.title !== undefined) patch.title = parsed.data.title;
    if (parsed.data.note !== undefined) patch.note = parsed.data.note;
    if (parsed.data.qty !== undefined) patch.qty = parsed.data.qty;
    if (parsed.data.metadata !== undefined) patch.metadata = jsonb(parsed.data.metadata);
    if (parsed.data.checked !== undefined) {
      patch.checked = parsed.data.checked;
      patch.checked_at = parsed.data.checked ? new Date() : null;
    }
    const row = await db.updateTable("core_lists_items").set(patch).where("id", "=", req.params.id!).returningAll().executeTakeFirst();
    if (!row) return void res.status(404).json({ error: { code: "not_found", message: "Item not found." } });
    if (parsed.data.checked !== undefined) {
      void platform().events.emit("core-lists.item.checked", { orgId: ctx.org.id, listId: row.list_id, itemId: row.id, checked: parsed.data.checked });
    }
    res.json(row);
  }),
);

listsRouter.delete(
  "/items/:id",
  asyncHandler(async (req, res) => {
    if (!requireRole(req, res, ...ROLES)) return;
    const db = tenantDb(req);
    const ctx = tenantContext(req);
    const row = await db.deleteFrom("core_lists_items").where("id", "=", req.params.id!).returning(["id", "list_id"]).executeTakeFirst();
    if (row) void platform().events.emit("core-lists.item.removed", { orgId: ctx.org.id, listId: row.list_id, itemId: row.id });
    res.status(204).end();
  }),
);
