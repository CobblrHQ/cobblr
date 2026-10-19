// /queue — list, add, remove. Each item carries everything the
// renderer needs (qr_payload + pre-rendered description) so we don't
// have to re-query the source module to print.

import { requireCapability } from "@cobblr/platform-contract/action-gate";
import { Router } from "express";
import { z } from "zod";
import { platform } from "@cobblr/platform-contract";
import { sessionUser, tenantContext, tenantDb } from "../db.js";
import { asyncHandler, badBody, requireRole } from "./util.js";
import { evaluateAutoflush } from "./autoflush.js";
import { qrBaseFor } from "./print.js";
import { liveQrUrl } from "../live-qr-url.js";

export const queueRouter = Router({ mergeParams: true });

// Block the read-only `guest` role from every mutating request on this
// router. (Audit 2026-06-26 P0 #1.)
queueRouter.use((req, res, next) => {
  if (req.method !== "GET" && req.method !== "HEAD" && req.method !== "OPTIONS") {
    if (!requireRole(req, res, "owner", "admin", "member")) return;
  }
  next();
});

const QueueAdd = z.object({
  module_name: z.string().min(1).max(80),
  entity_type: z.string().min(1).max(80),
  entity_id: z.string().min(1).max(120),
  qr_payload: z.string().min(1).max(2_000),
  description: z.string().min(1).max(500),
  qty: z.number().int().min(1).max(99).default(1),
});

// GET /queue/count: how many labels are waiting to print for this person, the
// number on the Labels row of every nav (manifest `nav.count`). One cheap sum,
// since every open tab asks it every few seconds.
queueRouter.get(
  "/count",
  asyncHandler(async (req, res) => {
    const row = await tenantDb(req)
      .selectFrom("labels_queue")
      .select((eb) => eb.fn.coalesce(eb.fn.sum<number>("qty"), eb.lit(0)).as("total"))
      .where("user_id", "=", sessionUser(req).id)
      .executeTakeFirst();
    res.json({ total: Number(row?.total ?? 0) });
  }),
);

queueRouter.get(
  "/",
  asyncHandler(async (req, res) => {
    const db = tenantDb(req);
    const session = sessionUser(req);
    const ctx = tenantContext(req);
    const rows = await db
      .selectFrom("labels_queue")
      .selectAll()
      .where("user_id", "=", session.id)
      .orderBy("created_at")
      .execute();
    // Each item's STOCK system name — the source entity's live title, re-resolved
    // so a trimmed caption can be reverted to it. Instance-aware: the stored kind
    // is `${module_name}:${entity_type}` (how enqueue split ent.kind), and a Vehicle
    // lives in a named instance the base kind can't see, so titleForEntity probes.
    // Best-effort per row — a deleted entity or a resolve error just yields null
    // (the client then hides revert), never a 500 on the whole queue. In-process
    // lookups over a small per-user set.
    //
    // kind_label: the entity's INSTANCE-AWARE kind name ("3D Printers"), so the row
    // shows that instead of the raw `machines/machine`. The workspace's kind labels
    // are fetched ONCE here; each row resolves its actual kind (base vs named
    // instance) and looks up the display name.
    // Each row's link is shown as it will print: Print draws every QR on the
    // workspace's label base, so the stored link (minted on whatever origin
    // queued it) read as one address on this page and printed as another.
    const base = await qrBaseFor(req);
    const kinds = await platform().entities.listKindsForOrg(ctx.org.id).catch(() => []);
    const labelByKind = new Map(kinds.map((k) => [k.id, k.display_name_plural ?? k.display_name]));
    const items = await Promise.all(
      rows.map(async (r) => {
        const baseKind = `${r.module_name}:${r.entity_type}`;
        let stock_title: string | null = null;
        let kind_label: string | null = null;
        try {
          stock_title = await platform().entities.titleForEntity(ctx.org.id, baseKind, r.entity_id);
        } catch {
          stock_title = null;
        }
        try {
          const rk = await platform().entities.resolvedKindForEntity(ctx.org.id, baseKind, r.entity_id);
          kind_label = labelByKind.get(rk) ?? null;
        } catch {
          kind_label = null;
        }
        return { ...r, qr_payload: liveQrUrl(r.qr_payload, base), stock_title, kind_label };
      }),
    );
    res.json({ items });
  }),
);

// AI-ACTION: labels:print
queueRouter.post(
  "/",
  asyncHandler(async (req, res) => {
    if (!(await requireCapability(req, res, "labels:print"))) return;
    const parsed = QueueAdd.safeParse(req.body);
    if (!parsed.success) return badBody(res, parsed.error);
    const db = tenantDb(req);
    const session = sessionUser(req);
    const ctx = tenantContext(req);

    const inserted = await db
      .insertInto("labels_queue")
      .values({
        user_id: session.id,
        module_name: parsed.data.module_name,
        entity_type: parsed.data.entity_type,
        entity_id: parsed.data.entity_id,
        qr_payload: parsed.data.qr_payload,
        description: parsed.data.description,
        qty: parsed.data.qty,
      })
      .returningAll()
      .executeTakeFirstOrThrow();

    platform().events.emit("labels.print.queued", {
      orgId: ctx.org.id,
      queueId: inserted.id,
      module: parsed.data.module_name,
      entity_type: parsed.data.entity_type,
      entity_id: parsed.data.entity_id,
    });

    // Auto-flush: a non-manual policy may render the due labels and dispatch them
    // now. Best-effort — a failure here must never fail the add (the row IS
    // inserted); the fire result rides along so the client can say "printed".
    let autoflush = null;
    try {
      autoflush = await evaluateAutoflush(db, ctx.org.id, session.id, await qrBaseFor(req));
    } catch (e) {
      console.error("[labels] auto-flush error:", (e as Error).message);
    }

    res.status(201).json(autoflush ? { ...inserted, autoflush } : inserted);
  }),
);

export const QueuePatch = z
  .object({
    qty: z.number().int().min(1).max(99).optional(),
    // The printed caption — editable so a long title can be trimmed to a short name
    // that fits the label. Empty is allowed (a QR-only label).
    description: z.string().max(200).optional(),
  })
  .refine((b) => b.qty !== undefined || b.description !== undefined, { message: "qty or description required" });

/** A queued label of this person's, changed: the route's PATCH and labels:change-queued-label. */
export async function changeQueued(db: ReturnType<typeof tenantDb>, userId: string, id: string, change: z.infer<typeof QueuePatch>) {
  const patch: Record<string, unknown> = {};
  if (change.qty !== undefined) patch.qty = change.qty;
  if (change.description !== undefined) patch.description = change.description.trim();
  return (await db.updateTable("labels_queue").set(patch).where("id", "=", id).where("user_id", "=", userId).returningAll().executeTakeFirst()) ?? null;
}

/** A queued label of this person's, taken off: the route's DELETE and labels:remove-queued-label. */
export async function removeQueued(db: ReturnType<typeof tenantDb>, userId: string, id: string) {
  return (await db.deleteFrom("labels_queue").where("id", "=", id).where("user_id", "=", userId).returningAll().executeTakeFirst()) ?? null;
}

// AI-ACTION: labels:change-queued-label
queueRouter.patch(
  "/:id",
  asyncHandler(async (req, res) => {
    if (!(await requireCapability(req, res, "labels:change-queued-label"))) return;
    const parsed = QueuePatch.safeParse(req.body);
    if (!parsed.success) return badBody(res, parsed.error);
    const updated = await changeQueued(tenantDb(req), sessionUser(req).id, req.params.id ?? "", parsed.data);
    if (!updated) return void res.status(404).json({ error: { code: "not_found", message: "queue item not found" } });
    res.json(updated);
  }),
);

// AI-ACTION: labels:remove-queued-label
queueRouter.delete(
  "/:id",
  asyncHandler(async (req, res) => {
    if (!(await requireCapability(req, res, "labels:remove-queued-label"))) return;
    const deleted = await removeQueued(tenantDb(req), sessionUser(req).id, req.params.id ?? "");
    if (!deleted) return void res.status(404).json({ error: { code: "not_found", message: "queue item not found" } });
    res.status(204).end();
  }),
);
