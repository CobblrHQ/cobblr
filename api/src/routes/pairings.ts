// /pairings — platform primitive for polymorphic relationships.
// "(source_kind, source_id) is related to (target_kind, target_id)
//  as a `relationship_kind`."
//
// Any module / bundle / UI can write here. Replaces the case-by-case
// "I need my own polymorphic-link table" pattern (the projects deps
// table will eventually move onto this).

import { Router } from "express";
import { z } from "zod";
import { sql } from "kysely";
import { meta } from "../db/meta.js";
import { requireAuth } from "../auth/middleware.js";
import { requireRole } from "../auth/capability.js";
import { withTenant } from "../middleware/tenant.js";
import * as activity from "../platform/activity.js";

export const pairingsRouter = Router({ mergeParams: true });

const PairingCreate = z.object({
  source_kind: z.string().min(1).max(80),
  source_id: z.string().min(1).max(120),
  target_kind: z.string().min(1).max(80),
  target_id: z.string().min(1).max(120),
  relationship_kind: z.string().min(1).max(80),
  notes: z.string().max(2000).nullable().optional(),
  metadata: z.record(z.unknown()).optional(),
});

// GET /pairings?source_kind=&source_id=&target_kind=&target_id=&relationship_kind=
pairingsRouter.get("/", requireAuth, withTenant, async (req, res, next) => {
  try {
    const params = req.query as Record<string, string | undefined>;
    let q = meta
      .selectFrom("entity_pairings")
      .selectAll()
      .where("org_id", "=", req.tenant!.org.id)
      .orderBy("created_at", "desc")
      .limit(500);
    if (params.source_kind) q = q.where("source_kind", "=", params.source_kind);
    if (params.source_id) q = q.where("source_id", "=", params.source_id);
    if (params.target_kind) q = q.where("target_kind", "=", params.target_kind);
    if (params.target_id) q = q.where("target_id", "=", params.target_id);
    if (params.relationship_kind) q = q.where("relationship_kind", "=", params.relationship_kind);
    const items = await q.execute();
    res.json({ items });
  } catch (err) {
    next(err);
  }
});

pairingsRouter.post("/", requireAuth, withTenant, async (req, res, next) => {
  try {
    if (!requireRole(req, res, "owner", "admin", "member")) return;
    const parsed = PairingCreate.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        error: { code: "invalid_body", message: "Bad pairing payload", details: parsed.error.issues },
      });
      return;
    }
    const inserted = await meta
      .insertInto("entity_pairings")
      .values({
        org_id: req.tenant!.org.id,
        source_kind: parsed.data.source_kind,
        source_id: parsed.data.source_id,
        target_kind: parsed.data.target_kind,
        target_id: parsed.data.target_id,
        relationship_kind: parsed.data.relationship_kind,
        notes: parsed.data.notes ?? null,
        metadata: parsed.data.metadata
          ? (sql`${JSON.stringify(parsed.data.metadata)}::jsonb` as unknown as Record<string, unknown>)
          : ({} as Record<string, unknown>),
        created_by: req.session!.id,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    await activity.log({
      orgId: req.tenant!.org.id,
      action: "pairing_created",
      ref: { module: null, entityType: "pairing", entityId: inserted.id },
      diff: {
        source_kind: parsed.data.source_kind,
        target_kind: parsed.data.target_kind,
        relationship_kind: parsed.data.relationship_kind,
      },
    });
    res.status(201).json(inserted);
  } catch (err) {
    next(err);
  }
});

const PairingPatch = z.object({
  notes: z.string().max(2000).nullable().optional(),
  metadata: z.record(z.unknown()).optional(),
});
pairingsRouter.patch("/:id", requireAuth, withTenant, async (req, res, next) => {
  try {
    if (!requireRole(req, res, "owner", "admin", "member")) return;
    const id = req.params.id;
    if (!id) {
      res.status(400).json({ error: { code: "missing_id", message: "id required" } });
      return;
    }
    const parsed = PairingPatch.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        error: { code: "invalid_body", message: "Bad patch", details: parsed.error.issues },
      });
      return;
    }
    const updated = await meta
      .updateTable("entity_pairings")
      .set({
        ...(parsed.data.notes !== undefined && { notes: parsed.data.notes }),
        ...(parsed.data.metadata && {
          metadata: sql`${JSON.stringify(parsed.data.metadata)}::jsonb` as unknown as Record<string, unknown>,
        }),
      })
      .where("id", "=", id)
      .where("org_id", "=", req.tenant!.org.id)
      .returningAll()
      .executeTakeFirst();
    if (!updated) {
      res.status(404).json({ error: { code: "not_found", message: "pairing not found" } });
      return;
    }
    res.json(updated);
  } catch (err) {
    next(err);
  }
});

pairingsRouter.delete("/:id", requireAuth, withTenant, async (req, res, next) => {
  try {
    if (!requireRole(req, res, "owner", "admin", "member")) return;
    const id = req.params.id;
    if (!id) {
      res.status(400).json({ error: { code: "missing_id", message: "id required" } });
      return;
    }
    const deleted = await meta
      .deleteFrom("entity_pairings")
      .where("id", "=", id)
      .where("org_id", "=", req.tenant!.org.id)
      .returning("id")
      .executeTakeFirst();
    if (!deleted) {
      res.status(404).json({ error: { code: "not_found", message: "pairing not found" } });
      return;
    }
    await activity.log({
      orgId: req.tenant!.org.id,
      action: "pairing_deleted",
      ref: { module: null, entityType: "pairing", entityId: deleted.id },
    });
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});
