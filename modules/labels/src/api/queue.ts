// /queue — list, add, remove. Each item carries everything the
// renderer needs (qr_payload + pre-rendered description) so we don't
// have to re-query the source module to print.

import { Router } from "express";
import { z } from "zod";
import { platform } from "@cobblr/platform-contract";
import { sessionUser, tenantContext, tenantDb } from "../db.js";
import { asyncHandler, badBody, requireRole } from "./util.js";

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

queueRouter.get(
  "/",
  asyncHandler(async (req, res) => {
    const db = tenantDb(req);
    const session = sessionUser(req);
    const rows = await db
      .selectFrom("labels_queue")
      .selectAll()
      .where("user_id", "=", session.id)
      .orderBy("created_at")
      .execute();
    res.json({ items: rows });
  }),
);

queueRouter.post(
  "/",
  asyncHandler(async (req, res) => {
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

    res.status(201).json(inserted);
  }),
);

queueRouter.delete(
  "/:id",
  asyncHandler(async (req, res) => {
    const db = tenantDb(req);
    const session = sessionUser(req);
    const id = req.params.id;
    if (!id) {
      res.status(400).json({ error: { code: "missing_id", message: "id required" } });
      return;
    }
    const deleted = await db
      .deleteFrom("labels_queue")
      .where("id", "=", id)
      .where("user_id", "=", session.id)
      .returning("id")
      .executeTakeFirst();
    if (!deleted) {
      res.status(404).json({ error: { code: "not_found", message: "queue item not found" } });
      return;
    }
    res.status(204).end();
  }),
);
