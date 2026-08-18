// /api/v1/orgs/:slug/modules/digifab/links —
// machine↔farm-printer mapping. "This farm printer IS this Cobblr
// machine", so a job linked to the machine routes to the right printer.

import { Router } from "express";
import { z } from "zod";
import { tenantDb } from "../db.js";
import { asyncHandler, badBody, requireRole } from "./util.js";

export const linksRouter = Router({ mergeParams: true });

const LINK_COLS = [
  "id",
  "connection_id",
  "remote_device_id",
  "remote_device_name",
  "machine_id",
  "machine_label",
  "created_at",
] as const;

const LinkCreate = z.object({
  connection_id: z.string().uuid(),
  remote_device_id: z.string().min(1).max(200),
  remote_device_name: z.string().max(200).nullable().optional(),
  machine_id: z.string().min(1).max(200),
  machine_label: z.string().max(200).nullable().optional(),
});

linksRouter.get(
  "/",
  asyncHandler(async (req, res) => {
    const rows = await tenantDb(req)
      .selectFrom("digifab_device_links")
      .select(LINK_COLS)
      .orderBy("created_at", "desc")
      .execute();
    res.json({ items: rows });
  }),
);

// AI-REACH: sends work to a physical machine through its manager; run-command is the one deliberate door
linksRouter.post(
  "/",
  asyncHandler(async (req, res) => {
    if (!requireRole(req, res, "owner", "admin")) return;
    const parsed = LinkCreate.safeParse(req.body);
    if (!parsed.success) return badBody(res, parsed.error);
    // One machine per farm printer — re-linking updates in place.
    const row = await tenantDb(req)
      .insertInto("digifab_device_links")
      .values({
        connection_id: parsed.data.connection_id,
        remote_device_id: parsed.data.remote_device_id,
        remote_device_name: parsed.data.remote_device_name ?? null,
        machine_id: parsed.data.machine_id,
        machine_label: parsed.data.machine_label ?? null,
      })
      .onConflict((oc) =>
        oc.columns(["connection_id", "remote_device_id"]).doUpdateSet({
          machine_id: parsed.data.machine_id,
          machine_label: parsed.data.machine_label ?? null,
          remote_device_name: parsed.data.remote_device_name ?? null,
        }),
      )
      .returning(LINK_COLS)
      .executeTakeFirstOrThrow();
    res.status(201).json(row);
  }),
);

// AI-REACH: destructive on a record with no undo path through the ledger; delete_record covers kinds that declare it
linksRouter.delete(
  "/:id",
  asyncHandler(async (req, res) => {
    if (!requireRole(req, res, "owner", "admin")) return;
    await tenantDb(req).deleteFrom("digifab_device_links").where("id", "=", req.params.id!).execute();
    res.status(204).end();
  }),
);
