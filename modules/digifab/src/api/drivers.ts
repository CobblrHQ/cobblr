// /api/v1/orgs/:slug/modules/digifab/drivers —
// install / list / uninstall machine-manager drivers at runtime. A user
// adds OctoPrint/Duet/… by installing a declarative manifest — no platform
// deploy. Built-ins (fdm_monster, mock) are always available and not stored.
// See docs/design-decisions/digifab-drivers.md.

import { Router } from "express";
import { sql } from "kysely";
import { platform } from "@cobblr/platform-contract";
import { tenantDb, tenantContext } from "../db.js";
import { asyncHandler, badBody, requireRole } from "./util.js";
import { BUILTIN_DRIVERS } from "../drivers/registry.js";
import { DriverManifest } from "../drivers/manifest.js";
import { DRIVER_CATALOG, EDGE_ADAPTER_CATALOG } from "../drivers/catalog.js";

export const driversRouter = Router({ mergeParams: true });

const DRIVER_COLS = ["id", "key", "name", "kind", "spec", "enabled", "created_at", "updated_at"] as const;

// The "app store" shelf: ready-to-install firmware drivers that ship with
// digifab. Browse here, then POST the chosen manifest to install it. Static
// (no DB, no auth beyond being in the workspace) — it's a catalog, not state.
driversRouter.get(
  "/catalog",
  asyncHandler(async (_req, res) => {
    res.json({
      drivers: DRIVER_CATALOG.map((e) => ({
        id: e.id, name: e.name, summary: e.summary, credentialHint: e.credentialHint, kind: e.kind, manifest: e.manifest,
      })),
      edgeAdapters: EDGE_ADAPTER_CATALOG,
    });
  }),
);

driversRouter.get(
  "/",
  asyncHandler(async (req, res) => {
    const installed = await tenantDb(req)
      .selectFrom("digifab_drivers")
      .select(DRIVER_COLS)
      .orderBy("created_at", "desc")
      .execute();
    res.json({ builtins: BUILTIN_DRIVERS, installed });
  }),
);

// Install a declarative-HTTP driver (a manifest). Upserts on the key so
// re-installing updates it. (Edge-adapter / sandboxed forms land later.)
driversRouter.post(
  "/",
  asyncHandler(async (req, res) => {
    if (!requireRole(req, res, "owner", "admin")) return;
    const parsed = DriverManifest.safeParse(req.body?.manifest ?? req.body);
    if (!parsed.success) return badBody(res, parsed.error);
    const m = parsed.data;
    if (BUILTIN_DRIVERS.some((b) => b.key === m.id)) {
      return void res.status(400).json({ error: { code: "reserved_key", message: `"${m.id}" is a built-in driver key` } });
    }
    const ctx = tenantContext(req);
    const row = await tenantDb(req)
      .insertInto("digifab_drivers")
      .values({ key: m.id, name: m.name, kind: "declarative", spec: sql`${JSON.stringify(m)}::jsonb` as never })
      .onConflict((oc) =>
        oc.column("key").doUpdateSet({ name: m.name, kind: "declarative", spec: sql`${JSON.stringify(m)}::jsonb` as never, updated_at: new Date() }),
      )
      .returning(DRIVER_COLS)
      .executeTakeFirstOrThrow();
    void platform().events.emit("digifab.driver.installed", { orgId: ctx.org.id, key: m.id });
    res.status(201).json(row);
  }),
);

driversRouter.delete(
  "/:key",
  asyncHandler(async (req, res) => {
    if (!requireRole(req, res, "owner", "admin")) return;
    await tenantDb(req).deleteFrom("digifab_drivers").where("key", "=", req.params.key!).execute();
    res.status(204).end();
  }),
);
