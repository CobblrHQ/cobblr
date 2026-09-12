// lists CRUD — lists + their items. Mounted at
//   /api/v1/orgs/:slug/modules/lists/
// Routes:
//   GET    /lists                 list all lists (+ open item counts)
//   POST   /lists                 create a list
//   GET    /lists/:id             one list + its items
//   PATCH  /lists/:id             rename / edit a list
//   DELETE /lists/:id             delete a list (cascades items)
//   POST   /lists/:id/clear-done  remove all checked items (the "clear done" sweep)
//   POST   /items                 add an item (body.list_id)
//   PATCH  /items/:id             toggle checked / claimed / edit
//   DELETE /items/:id             remove an item

import { Router } from "express";
import { sql } from "kysely";
import { platform, sourceIdKey, type WireEffect } from "@cobblr/platform-contract";
import { goodUntil, startsFreshLot } from "@cobblr/platform-contract/fresh-lot";
import { z } from "zod";
import { tenantContext, tenantDb, sessionUser } from "../db.js";
import { asyncHandler, badBody, requireRole } from "./util.js";

export const listsRouter = Router({ mergeParams: true });

const jsonb = (v: unknown) => sql`${JSON.stringify(v ?? {})}::jsonb`;

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
    if (!requireRole(req, res, "member")) return;
    const db = tenantDb(req);
    const lists = await db.selectFrom("lists_lists").selectAll().orderBy("created_at", "desc").execute();
    // open-item counts in one grouped query
    const counts = await db
      .selectFrom("lists_items")
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
    if (!requireRole(req, res, "member")) return;
    const parsed = ListCreate.safeParse(req.body);
    if (!parsed.success) return badBody(res, parsed.error);
    const db = tenantDb(req);
    const ctx = tenantContext(req);
    const row = await db
      .insertInto("lists_lists")
      .values({
        title: parsed.data.title,
        description: parsed.data.description ?? null,
        metadata: jsonb(parsed.data.metadata) as never,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    void platform().events.emit("lists.list.created", { orgId: ctx.org.id, listId: row.id });
    res.status(201).json(row);
  }),
);

/** What checking the line off will stamp on its record, when the restock it
 *  fires starts a dated lot (the same rule the record applies:
 *  @cobblr/platform-contract/fresh-lot). The record's on-hand count and shelf
 *  life come through the entities door; a record with no shelf life is dated
 *  but not given a use-by. Null when the check-off restocks nothing, or adds to
 *  a stocked record without a restock wire. */
async function willDate(
  orgId: string,
  ref: { kind: string; id: string },
  effects: WireEffect[],
): Promise<{ on: string; until: string | null } | null> {
  const restock = effects.find((e) => /:adjust-stock$/.test(e.action_id) && typeof e.args?.delta === "number" && (e.args.delta as number) > 0);
  if (!restock) return null;
  let fields: Record<string, unknown> = {};
  try {
    fields = (await platform().entities.lookup(orgId, ref.kind, ref.id))?.fields ?? {};
  } catch {
    return null;
  }
  const qty = Number(fields.qty);
  const starts = startsFreshLot({
    delta: restock.args!.delta as number,
    qtyBefore: Number.isFinite(qty) ? qty : 0,
    restock: restock.args?.restock === true,
  });
  if (!starts) return null;
  const today = new Date().toISOString().slice(0, 10);
  // Custom fields ride under `metadata` on a resolved record; the shelf life
  // is the same key the lots read (batches.ts).
  const md = (fields.metadata as Record<string, unknown> | null) ?? {};
  const shelf = Number(md.shelf_life_days ?? fields.shelf_life_days);
  return { on: today, until: goodUntil(today, Number.isFinite(shelf) ? shelf : null) };
}

listsRouter.get(
  "/lists/:id",
  asyncHandler(async (req, res) => {
    if (!requireRole(req, res, "member")) return;
    const db = tenantDb(req);
    const list = await db.selectFrom("lists_lists").selectAll().where("id", "=", req.params.id!).executeTakeFirst();
    if (!list) return void res.status(404).json({ error: { code: "not_found", message: "List not found." } });
    const items = await db
      .selectFrom("lists_items")
      .selectAll()
      .where("list_id", "=", req.params.id!)
      // open items first, then by creation; checked sink to the bottom
      .orderBy("checked", "asc")
      .orderBy("created_at", "asc")
      .execute();
    // What checking a line off will DO, on the line. A line seeded from another
    // record restocks it (and files a purchase) through wires, and the row said
    // nothing about it: milk went 0 to 2 with no visible amount or reason
    // (2026-09-12). The kernel says which wires would fire for the line's
    // record; the row shows them and lets the amount be corrected first.
    const ctx = tenantContext(req);
    const effectsByKind = new Map<string, WireEffect[]>();
    const annotated = [];
    for (const it of items) {
      const ref = ((it.metadata as { source_ref?: { kind?: string; id?: string } } | null) ?? {}).source_ref;
      if (!ref?.kind || !ref.id || it.checked) {
        annotated.push(it);
        continue;
      }
      let effects = effectsByKind.get(ref.kind);
      if (!effects) {
        effects = await platform().wires.effectsOf(ctx.org.id, "lists.item.checked", ref.kind);
        effectsByKind.set(ref.kind, effects);
      }
      annotated.push({ ...it, on_check: effects, will_date: await willDate(ctx.org.id, { kind: ref.kind, id: ref.id }, effects) });
    }
    res.json({ ...list, items: annotated });
  }),
);

listsRouter.patch(
  "/lists/:id",
  asyncHandler(async (req, res) => {
    if (!requireRole(req, res, "member")) return;
    const parsed = ListUpdate.safeParse(req.body);
    if (!parsed.success) return badBody(res, parsed.error);
    const db = tenantDb(req);
    const patch: Record<string, unknown> = { updated_at: new Date() };
    if (parsed.data.title !== undefined) patch.title = parsed.data.title;
    if (parsed.data.description !== undefined) patch.description = parsed.data.description;
    if (parsed.data.metadata !== undefined) patch.metadata = jsonb(parsed.data.metadata);
    const row = await db.updateTable("lists_lists").set(patch).where("id", "=", req.params.id!).returningAll().executeTakeFirst();
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
    await db.deleteFrom("lists_lists").where("id", "=", req.params.id!).execute();
    void platform().events.emit("lists.list.deleted", { orgId: ctx.org.id, listId: req.params.id });
    res.status(204).end();
  }),
);

// AI-ACTION: lists:clear-done
listsRouter.post(
  "/lists/:id/clear-done",
  asyncHandler(async (req, res) => {
    if (!requireRole(req, res, "member")) return;
    const db = tenantDb(req);
    const r = await db.deleteFrom("lists_items").where("list_id", "=", req.params.id!).where("checked", "=", true).executeTakeFirst();
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
  /** How many were bought, stated with the check. The wires that restock the
   *  line's record and file its purchase take this over their fixed amount;
   *  the row shows that amount as the default and lets it be corrected. */
  quantity: z.number().int().positive().max(100_000).optional(),
  /** "I'm getting this" / "never mind". The claimer is always the caller — a
   *  claim is a statement about yourself, never an assignment handed to someone
   *  else, so there is no user id in the body to spoof. */
  claimed: z.boolean().optional(),
  metadata: z.record(z.unknown()).optional(),
});

listsRouter.post(
  "/items",
  asyncHandler(async (req, res) => {
    if (!requireRole(req, res, "member")) return;
    const parsed = ItemCreate.safeParse(req.body);
    if (!parsed.success) return badBody(res, parsed.error);
    const db = tenantDb(req);
    const ctx = tenantContext(req);
    // the list must exist (and scopes to this tenant DB)
    const list = await db.selectFrom("lists_lists").select("id").where("id", "=", parsed.data.list_id).executeTakeFirst();
    if (!list) return void res.status(404).json({ error: { code: "not_found", message: "List not found." } });
    const row = await db
      .insertInto("lists_items")
      .values({
        list_id: parsed.data.list_id,
        title: parsed.data.title,
        note: parsed.data.note ?? null,
        qty: parsed.data.qty ?? null,
        metadata: jsonb(parsed.data.metadata) as never,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    void platform().events.emit("lists.item.added", { orgId: ctx.org.id, listId: row.list_id, itemId: row.id });
    res.status(201).json(row);
  }),
);

listsRouter.patch(
  "/items/:id",
  asyncHandler(async (req, res) => {
    if (!requireRole(req, res, "member")) return;
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
      // The amount bought is the line's amount from now on, so a shared list
      // reads "×3" on every phone, not only the one that said so.
      if (parsed.data.checked && parsed.data.quantity !== undefined) patch.qty = String(parsed.data.quantity);
      // Buying it settles the question of who was getting it. Leaving the claim
      // on a checked line would show "Sam is getting this" next to a line Sam
      // already got.
      if (parsed.data.checked) {
        patch.claimed_by = null;
        patch.claimed_by_name = null;
        patch.claimed_at = null;
      }
    }
    if (parsed.data.claimed !== undefined) {
      const who = sessionUser(req);
      patch.claimed_by = parsed.data.claimed ? (who?.id ?? null) : null;
      patch.claimed_by_name = parsed.data.claimed ? (who?.display_name || who?.email || null) : null;
      patch.claimed_at = parsed.data.claimed ? new Date() : null;
    }
    const row = await db.updateTable("lists_items").set(patch).where("id", "=", req.params.id!).returningAll().executeTakeFirst();
    if (!row) return void res.status(404).json({ error: { code: "not_found", message: "Item not found." } });
    if (parsed.data.checked !== undefined) {
      // If this line was seeded from another entity (carries a source_ref) and
      // is being CHECKED (bought), surface that entity's id under the wire
      // engine's <kindSuffix>Id convention — for WHATEVER kind seeded it, via
      // the shared sourceIdKey() helper, no per-kind branch. A food-cluster wire
      // (source_kind inventory:part) reads `partId` and restocks; a future
      // source kind works the same with zero changes here. On uncheck — or a
      // line with no source_ref — the key is absent and the wire engine resolves
      // no source entity and fires nothing (a clean no-op).
      const meta = (row.metadata as { source_ref?: { kind?: string; id?: string } } | null) ?? {};
      const ref = meta.source_ref;
      // Through the BASE kind for the same reason the wire engine reads it that
      // way: a line seeded from an INSTANCE record carries `supplies:item`,
      // which would publish `itemId` while the listening wire reads `partId`.
      // Both ends have to agree on the module's key, not the instance's.
      const refBaseKind =
        ref?.kind && ref.id ? await platform().entities.baseKindOf(ctx.org.id, ref.kind) : null;
      const sourceKey =
        parsed.data.checked && refBaseKind && ref?.id ? sourceIdKey(refBaseKind) : undefined;
      // Awaited: the wires on this event MOVE stock (adjust-stock, the
      // cadence purchase), and the client re-reads that stock the moment this
      // route answers (the row's inventory badge, the Groceries page). A
      // fire-and-forget emit let the answer beat the restock, the same shape
      // as the digifab cancel race (#2826). emit never rejects.
      await platform().events.emit("lists.item.checked", {
        orgId: ctx.org.id,
        listId: row.list_id,
        itemId: row.id,
        checked: parsed.data.checked,
        ...(sourceKey ? { [sourceKey]: ref!.id, sourceRef: ref } : {}),
        // `quantity`: how many the person said they got. An action whose
        // amount is a wire's fixed arg (adjust-stock's delta, record-event's
        // qty_delta) takes a stated quantity over it; see those handlers.
        ...(parsed.data.checked && parsed.data.quantity !== undefined ? { quantity: parsed.data.quantity } : {}),
      });
    }
    if (parsed.data.claimed !== undefined) {
      void platform().events.emit("lists.item.claimed", {
        orgId: ctx.org.id,
        listId: row.list_id,
        itemId: row.id,
        claimed: parsed.data.claimed,
        claimedBy: row.claimed_by,
        claimedByName: row.claimed_by_name,
      });
    }
    res.json(row);
  }),
);

listsRouter.delete(
  "/items/:id",
  asyncHandler(async (req, res) => {
    if (!requireRole(req, res, "member")) return;
    const db = tenantDb(req);
    const ctx = tenantContext(req);
    const row = await db.deleteFrom("lists_items").where("id", "=", req.params.id!).returning(["id", "list_id"]).executeTakeFirst();
    if (row) void platform().events.emit("lists.item.removed", { orgId: ctx.org.id, listId: row.list_id, itemId: row.id });
    res.status(204).end();
  }),
);
