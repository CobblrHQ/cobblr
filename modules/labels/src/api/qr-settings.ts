// Per-workspace QR settings (merged in from the former core-labels-qr
// module): token style (descriptive | opaque) + an optional custom label base
// URL (a stable domain/DuckDNS/Tailscale name the workspace forwards to this
// instance so printed codes survive a move — see labels migration 0004).

import { Router } from "express";
import { z } from "zod";
import { qrTenantDb, getQrTokenStyle, getQrLabelBaseUrl } from "./qr-db.js";
import { asyncHandler, badBody, requireRole } from "./util.js";

export const qrSettingsRouter = Router({ mergeParams: true });

async function currentSettings(db: ReturnType<typeof qrTenantDb>) {
  return {
    token_style: await getQrTokenStyle(db),
    label_base_url: await getQrLabelBaseUrl(db),
  };
}

qrSettingsRouter.get(
  "/",
  asyncHandler(async (req, res) => {
    res.json(await currentSettings(qrTenantDb(req)));
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

qrSettingsRouter.put(
  "/",
  asyncHandler(async (req, res) => {
    if (!requireRole(req, res, "owner", "admin")) return;
    const parsed = SettingsUpdate.safeParse(req.body);
    if (!parsed.success) return badBody(res, parsed.error);
    const db = qrTenantDb(req);

    // The singleton row is seeded by the migration; make sure it's there,
    // then patch only the supplied columns.
    await db
      .insertInto("labels_qr_settings")
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
      .updateTable("labels_qr_settings")
      .set(patch as never)
      .where("id", "=", 1)
      .execute();

    res.json(await currentSettings(db));
  }),
);
