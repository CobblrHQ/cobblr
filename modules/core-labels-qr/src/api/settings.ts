// Per-workspace QR settings — currently the token style (descriptive | opaque).

import { Router } from "express";
import { z } from "zod";
import { tenantDb, getQrTokenStyle } from "../db.js";
import { asyncHandler, badBody, requireRole } from "./util.js";

export const settingsRouter = Router({ mergeParams: true });

settingsRouter.get(
  "/",
  asyncHandler(async (req, res) => {
    res.json({ token_style: await getQrTokenStyle(tenantDb(req)) });
  }),
);

const SettingsUpdate = z.object({
  token_style: z.enum(["descriptive", "opaque"]),
});

settingsRouter.put(
  "/",
  asyncHandler(async (req, res) => {
    if (!requireRole(req, res, "owner", "admin")) return;
    const parsed = SettingsUpdate.safeParse(req.body);
    if (!parsed.success) return badBody(res, parsed.error);
    await tenantDb(req)
      .insertInto("core_labels_qr_settings")
      .values({ id: 1, token_style: parsed.data.token_style })
      .onConflict((oc) =>
        oc.column("id").doUpdateSet({ token_style: parsed.data.token_style, updated_at: new Date() }),
      )
      .execute();
    res.json({ token_style: parsed.data.token_style });
  }),
);
