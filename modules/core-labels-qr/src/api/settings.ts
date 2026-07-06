// Per-workspace QR settings: token style (descriptive | opaque) + an optional
// custom label base URL (a stable domain/DuckDNS/Tailscale name the workspace
// forwards to this instance so printed codes survive a move — see migration 0003).

import { Router } from "express";
import { z } from "zod";
import { tenantDb, getQrTokenStyle, getQrLabelBaseUrl } from "../db.js";
import { asyncHandler, badBody, requireRole } from "./util.js";

export const settingsRouter = Router({ mergeParams: true });

async function currentSettings(db: ReturnType<typeof tenantDb>) {
  return {
    token_style: await getQrTokenStyle(db),
    label_base_url: await getQrLabelBaseUrl(db),
  };
}

settingsRouter.get(
  "/",
  asyncHandler(async (req, res) => {
    res.json(await currentSettings(tenantDb(req)));
  }),
);

// Partial update — only the provided fields change. An empty-string
// label_base_url clears the custom base (falls back to the serving origin).
const SettingsUpdate = z
  .object({
    token_style: z.enum(["descriptive", "opaque"]).optional(),
    label_base_url: z.union([z.string().trim().url(), z.literal("")]).nullable().optional(),
  })
  .refine((v) => v.token_style !== undefined || v.label_base_url !== undefined, {
    message: "no settings fields provided",
  });

settingsRouter.put(
  "/",
  asyncHandler(async (req, res) => {
    if (!requireRole(req, res, "owner", "admin")) return;
    const parsed = SettingsUpdate.safeParse(req.body);
    if (!parsed.success) return badBody(res, parsed.error);
    const db = tenantDb(req);

    // The singleton row is seeded by the migration; make sure it's there,
    // then patch only the supplied columns.
    await db
      .insertInto("core_labels_qr_settings")
      .values({ id: 1 })
      .onConflict((oc) => oc.column("id").doNothing())
      .execute();

    const patch: Record<string, unknown> = { updated_at: new Date() };
    if (parsed.data.token_style !== undefined) patch.token_style = parsed.data.token_style;
    if (parsed.data.label_base_url !== undefined) {
      const v = parsed.data.label_base_url;
      patch.label_base_url = v ? v.replace(/\/+$/, "") : null;
    }
    await db
      .updateTable("core_labels_qr_settings")
      .set(patch as never)
      .where("id", "=", 1)
      .execute();

    res.json(await currentSettings(db));
  }),
);
