// /api/v1/orgs/:slug/modules/core-devices/links — the device → entity LINK.
//
// ONE table, two surfaces (the author's "both ends"):
//   • Central admin — GET /links (all rows): every sensor mapping in one place.
//   • Per-entity field — GET /links?entity_kind=&entity_id= : "what feeds THIS
//     part?", rendered as a "Linked sensor" affordance on the entity's detail.
// Both read/write the SAME rows. A wire later resolves (connection, device) →
// entity and acts via the entity-owning module's action (the resolution seam;
// see docs/architecture/core-devices-extraction.md §4).

import { Router } from "express";
import { z } from "zod";
import { sql } from "kysely";
import { tenantDb } from "../db.js";
import { asyncHandler, badBody, requireRole } from "./util.js";

export const linksRouter = Router({ mergeParams: true });

const COLS = [
  "id",
  "connection_id",
  "device",
  "entity_kind",
  "entity_id",
  "mode",
  "config",
  "created_at",
  "updated_at",
] as const;

const LinkCreate = z.object({
  connection_id: z.string().uuid(),
  device: z.string().min(1).max(128),
  entity_kind: z.string().min(1).max(64),
  entity_id: z.string().uuid(),
  mode: z.enum(["set", "add", "log", "loan"]).default("set"),
  config: z.record(z.unknown()).optional(),
});

// GET /links — all links (central admin), or filtered by entity / connection
// (the per-entity field uses ?entity_kind=&entity_id=). Read = any role.
linksRouter.get(
  "/",
  asyncHandler(async (req, res) => {
    if (!requireRole(req, res, "owner", "admin", "member", "guest")) return;
    let q = tenantDb(req).selectFrom("core_devices_links").select(COLS);
    const { entity_kind, entity_id, connection_id } = req.query;
    if (typeof entity_kind === "string") q = q.where("entity_kind", "=", entity_kind);
    if (typeof entity_id === "string") q = q.where("entity_id", "=", entity_id);
    if (typeof connection_id === "string") q = q.where("connection_id", "=", connection_id);
    const items = await q.orderBy("created_at", "desc").execute();
    res.json({ items });
  }),
);

// POST /links — create or update a link (idempotent on the device↔entity pair).
linksRouter.post(
  "/",
  asyncHandler(async (req, res) => {
    if (!requireRole(req, res, "owner", "admin", "member")) return;
    const parsed = LinkCreate.safeParse(req.body);
    if (!parsed.success) return badBody(res, parsed.error);
    const d = parsed.data;
    const cfg = sql`${JSON.stringify(d.config ?? {})}::jsonb` as never;
    const row = await tenantDb(req)
      .insertInto("core_devices_links")
      .values({
        connection_id: d.connection_id,
        device: d.device,
        entity_kind: d.entity_kind,
        entity_id: d.entity_id,
        mode: d.mode,
        config: cfg,
      })
      .onConflict((oc) =>
        oc
          .columns(["connection_id", "device", "entity_kind", "entity_id"])
          .doUpdateSet({ mode: d.mode, config: cfg, updated_at: sql`now()` as never }),
      )
      .returning(COLS)
      .executeTakeFirstOrThrow();
    res.status(201).json(row);
  }),
);

// DELETE /links/:id — unlink.
linksRouter.delete(
  "/:id",
  asyncHandler(async (req, res) => {
    if (!requireRole(req, res, "owner", "admin", "member")) return;
    const r = await tenantDb(req)
      .deleteFrom("core_devices_links")
      .where("id", "=", req.params.id as string)
      .returning(["id"])
      .executeTakeFirst();
    if (!r) {
      res.status(404).json({ error: { code: "not_found", message: "no such link" } });
      return;
    }
    res.json({ ok: true });
  }),
);
