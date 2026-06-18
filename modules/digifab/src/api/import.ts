// /api/v1/orgs/:slug/modules/digifab/import — migrate a farm into Cobblr.
//
// FDM Monster import, two modes (the author's call — offer both):
//   • DIRECT  — read FDMM's printer list (each carries its underlying controller
//     URL + key + protocol) and recreate each as a DIRECT Cobblr connection of
//     the MATCHING driver type (FDMM speaks the same protocols as us bar RRF, so
//     a printer may be OctoPrint, Klipper/Moonraker, PrusaLink, … — not just
//     OctoPrint). Auto-installs the needed declarative drivers. Drops FDMM from
//     the path; you can delete the FDM Monster connection after.
//   • MIRROR  — keep ONE FDM Monster connection and just create a Cobblr pool
//     mirroring its printers, so the queue + fleet group them. FDMM stays in the
//     path (it still does the printer comms).
// Either way you end up with a pool. Coordinate-not-control throughout.

import { Router } from "express";
import { z } from "zod";
import { platform } from "@cobblr/platform-contract";
import { tenantDb, tenantContext } from "../db.js";
import { asyncHandler, badBody, requireRole } from "./util.js";
import { buildDriverById } from "../jobs-core.js";
import { resolveDriver } from "../drivers/registry.js";
import { FdmMonsterDriver } from "../drivers/fdm-monster.js";
import { ensureDeclarativeDrivers, createPool, addPoolMember } from "./farm-build.js";

export const importRouter = Router({ mergeParams: true });

const store = () => platform().devices.connections();

const Body = z
  .object({
    // Either an existing FDMM connection, or fresh credentials to read from.
    connection_id: z.string().uuid().optional(),
    base_url: z.string().url().max(500).optional(),
    api_key: z.string().max(500).optional(),
    username: z.string().max(200).optional(),
    password: z.string().max(200).optional(),
    mode: z.enum(["direct", "mirror"]),
    pool_name: z.string().min(1).max(120).default("Imported farm"),
  })
  .refine((b) => b.connection_id || b.base_url, { message: "connection_id or base_url required" });

importRouter.post(
  "/fdm-monster",
  asyncHandler(async (req, res) => {
    if (!requireRole(req, res, "owner", "admin")) return;
    const ctx = tenantContext(req);
    const db = tenantDb(req);
    const parsed = Body.safeParse(req.body);
    if (!parsed.success) return void badBody(res, parsed.error);
    const { mode } = parsed.data;

    // Build the FDMM driver — from the existing connection or fresh creds.
    let fdmmConnId = parsed.data.connection_id ?? null;
    const driver = fdmmConnId
      ? await buildDriverById(db, ctx.org.id, fdmmConnId)
      : await resolveDriver(
          db,
          "fdm_monster",
          {
            baseUrl: parsed.data.base_url!,
            apiKey: parsed.data.api_key ?? null,
            username: parsed.data.username ?? null,
            password: parsed.data.password ?? null,
          },
          "import",
        );
    if (!(driver instanceof FdmMonsterDriver)) {
      return void res.status(400).json({ error: { code: "not_fdmm", message: "needs an FDM Monster connection or credentials" } });
    }

    let targets;
    try {
      targets = await driver.listImportTargets();
    } catch (err) {
      return void res.status(502).json({ error: { code: "fdmm_unreachable", message: (err as Error).message } });
    }

    const poolId = await createPool(db, parsed.data.pool_name);
    const addMember = (connId: string, deviceId: string) => addPoolMember(db, poolId, connId, deviceId);

    if (mode === "mirror") {
      // Keep one FDMM connection; create it from creds if it wasn't an existing one.
      if (!fdmmConnId) {
        const c = await store().create(ctx.org.id, {
          type: "fdm_monster",
          label: "FDM Monster",
          base_url: parsed.data.base_url!,
          creds: {
            ...(parsed.data.api_key ? { apiKey: parsed.data.api_key } : {}),
            ...(parsed.data.username ? { username: parsed.data.username } : {}),
            ...(parsed.data.password ? { password: parsed.data.password } : {}),
          },
        });
        fdmmConnId = c.id;
      }
      for (const t of targets) await addMember(fdmmConnId, t.id);
      return void res.json({ mode, pool_id: poolId, pool_name: parsed.data.pool_name, mirrored: targets.length });
    }

    // DIRECT — recreate each printer as its own connection of the matching type.
    // Auto-install the declarative drivers we'll need (octoprint/klipper/…).
    await ensureDeclarativeDrivers(db, targets.map((t) => t.driverType));

    let created = 0;
    let skipped = 0;
    for (const t of targets) {
      if (!t.url) {
        skipped++; // FDMM didn't expose this printer's controller URL — can't go direct
        continue;
      }
      const conn = await store().create(ctx.org.id, {
        type: t.driverType,
        label: t.name,
        base_url: t.url,
        creds: t.apiKey ? { apiKey: t.apiKey } : {},
      });
      // Pool the new connection's device(s). Best-effort — the connection is made
      // regardless; an unreachable printer just isn't pooled yet.
      try {
        const d = await buildDriverById(db, ctx.org.id, conn.id);
        const devs = d ? await d.listDevices() : [];
        for (const dev of devs) await addMember(conn.id, dev.id);
      } catch {
        /* pooling best-effort */
      }
      created++;
    }
    res.json({ mode, pool_id: poolId, pool_name: parsed.data.pool_name, created, skipped });
  }),
);
