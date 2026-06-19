// POST /api/v1/orgs/:slug/modules/core-scan/entity-image
// Fire-and-forget: kick off an automatic web image search for an entity (e.g. a
// 3D printer) and set its image_path when it lands — so the user does nothing.
// Returns 202 immediately; the photo appears on the next refresh.

import { Router } from "express";
import { z } from "zod";
import { asyncHandler, badBody, requireRole } from "./util.js";
import { bearer } from "../db.js";
import { enrichEntityImage } from "../services/entity-image.js";

export const entityImageRouter = Router({ mergeParams: true });

const Body = z.object({
  entity_kind: z.string().min(1).max(64),
  entity_id: z.string().min(1).max(100),
  query: z.string().min(2).max(200),
  instance: z.string().max(80).nullable().optional(),
});

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
    // Don't make the client wait on a web search + image download — fire it and
    // return; the image_path is set on the entity when it completes.
    void enrichEntityImage({
      orgSlug: slug,
      bearer: token,
      entityKind: parsed.data.entity_kind,
      entityId: parsed.data.entity_id,
      query: parsed.data.query,
      instance: parsed.data.instance ?? null,
    });
    res.status(202).json({ ok: true });
  }),
);
