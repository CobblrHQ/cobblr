// Install / list / uninstall declarative sync-source manifests at runtime. A
// workspace adds a sync source (a self-hosted inventory app, a Notion DB, …) by installing a
// SyncSourceManifest — no platform deploy, nothing source-specific in the tree.
// Mirrors digifab's driver install (modules/digifab/src/api/drivers.ts).

import { Router } from "express";
import { sql } from "kysely";
import { platform } from "@cobblr/platform-contract";
import { tenantDb } from "../db.js";
import { asyncHandler, badBody, requireRole } from "./util.js";
import { SyncSourceManifest } from "../sync/manifest.js";

export const sourceDefsRouter = Router({ mergeParams: true });

const COLS = [
  "id",
  "source_id",
  "name",
  "manifest",
  "enabled",
  "created_at",
  "updated_at",
] as const;

// List this workspace's installed sync sources.
sourceDefsRouter.get(
  "/",
  asyncHandler(async (req, res) => {
    const installed = await tenantDb(req)
      .selectFrom("core_integrations_sync_source_defs")
      .select(COLS)
      .orderBy("created_at")
      .execute();
    res.json({ installed });
  }),
);

// Install a declarative sync source (a manifest). Upserts on source_id so
// re-installing updates it.
sourceDefsRouter.post(
  "/",
  asyncHandler(async (req, res) => {
    if (!requireRole(req, res, "owner", "admin")) return;
    const parsed = SyncSourceManifest.safeParse(req.body?.manifest ?? req.body);
    if (!parsed.success) return badBody(res, parsed.error);
    const m = parsed.data;
    if (platform().integrations.getSyncConnector(m.id)) {
      return void res.status(400).json({
        error: { code: "reserved_id", message: `"${m.id}" is a built-in connector id` },
      });
    }
    const row = await tenantDb(req)
      .insertInto("core_integrations_sync_source_defs")
      .values({
        source_id: m.id,
        name: m.name,
        manifest: sql`${JSON.stringify(m)}::jsonb` as never,
      })
      .onConflict((oc) =>
        oc.column("source_id").doUpdateSet({
          name: m.name,
          manifest: sql`${JSON.stringify(m)}::jsonb` as never,
          updated_at: new Date(),
        }),
      )
      .returning(COLS)
      .executeTakeFirstOrThrow();
    res.status(201).json(row);
  }),
);

// Uninstall.
sourceDefsRouter.delete(
  "/:sourceId",
  asyncHandler(async (req, res) => {
    if (!requireRole(req, res, "owner", "admin")) return;
    await tenantDb(req)
      .deleteFrom("core_integrations_sync_source_defs")
      .where("source_id", "=", req.params.sourceId!)
      .execute();
    res.status(204).end();
  }),
);
