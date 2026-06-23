// POST /api/v1/orgs/:slug/modules/core-scan/entity-image
// Automatic web image search for an entity (e.g. a 3D printer): search → fetch →
// store → set image_path. Returns the resolved { image_path } (or null) so the
// caller can refetch and show the photo LIVE while the detail modal is open — no
// refresh needed. The user does nothing.

import { Router } from "express";
import { z } from "zod";
import { asyncHandler, badBody, requireRole } from "./util.js";
import { bearer } from "../db.js";
import { enrichEntityImage } from "../services/entity-image.js";
import { searchImages, rankImageOptions } from "../services/ddg-images.js";

export const entityImageRouter = Router({ mergeParams: true });

const Body = z.object({
  entity_kind: z.string().min(1).max(64),
  entity_id: z.string().min(1).max(100),
  query: z.string().min(2).max(200),
  instance: z.string().max(80).nullable().optional(),
  /** A specific web-image url the user picked (skips auto-search). */
  image_url: z.string().url().max(2000).optional(),
});

// GET /image-options?q=<query>&brand=<brand> — generic web-image candidates for
// ANY entity (the universal "search the web for a photo" strip). Same DDG search
// + catalog-quality ranking the scan inbox uses, decoupled from a scan item.
const OptionsQuery = z.object({ q: z.string().min(2).max(200), brand: z.string().max(120).optional() });
entityImageRouter.get(
  "/image-options",
  asyncHandler(async (req, res) => {
    if (!requireRole(req, res, "owner", "admin", "member")) return;
    const parsed = OptionsQuery.safeParse(req.query);
    if (!parsed.success) return badBody(res, parsed.error);
    const pool = await searchImages(parsed.data.q, 24).catch(() => []);
    const items = rankImageOptions(pool, parsed.data.brand ?? null).slice(0, 12);
    res.json({ items });
  }),
);

entityImageRouter.post(
  "/entity-image",
  asyncHandler(async (req, res) => {
    if (!requireRole(req, res, "owner", "admin", "member")) return;
    const parsed = Body.safeParse(req.body);
    if (!parsed.success) return badBody(res, parsed.error);
    const token = bearer(req);
    if (!token) return void res.status(401).json({ error: { code: "no_auth", message: "missing bearer" } });
    const slug = req.params.slug;
    if (!slug) return void res.status(400).json({ error: { code: "no_slug", message: "missing slug" } });
    // Await the search + download + set so the caller gets the resolved
    // image_path and can show it live. Bounded (~8s fetch + the search), and
    // best-effort: enrichEntityImage never throws (null on any failure).
    const image_path = await enrichEntityImage({
      orgSlug: slug,
      bearer: token,
      entityKind: parsed.data.entity_kind,
      entityId: parsed.data.entity_id,
      query: parsed.data.query,
      instance: parsed.data.instance ?? null,
      imageUrl: parsed.data.image_url ?? null,
    });
    res.json({ image_path });
  }),
);
