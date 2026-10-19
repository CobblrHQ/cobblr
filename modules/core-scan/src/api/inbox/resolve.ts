// The image proxy, and its-this-one: a person names which candidate a scan is.
// Split from api/inbox.ts by route group (#7385); inbox.ts mounts the groups in order.
import { Router } from "express";
import { fetchShownImage } from "../../services/shown-images.js";
import { z } from "zod";
import { tenantContext } from "../../db.js";
import { asyncHandler, badBody, requireRole } from "../util.js";
import { guardedImageFetch, isUnusablePictureUrl } from "../../services/enrich.js";
import { RecordRef, putPaperworkOn } from "./shared.js";

export const resolveRouter = Router({ mergeParams: true });

// A web picture SHOWN through Cobblr (shown-images.ts, #4580): a search
// result's tile and the full-size viewer load from here, so the bytes the
// person sees are the bytes a Use it stores, and the site is asked once. The
// address is the person's search result, so it goes through the image fetch's
// own guard (no private addresses, every redirect checked).
const ImageProxyQuery = z.object({
  url: z.string().url().max(4000),
  /** The page the result was found on, for sites that serve their pictures
   *  only to their own pages. */
  page: z.string().url().max(4000).optional(),
});
resolveRouter.get(
  "/image-proxy",
  asyncHandler(async (req, res) => {
    const parsed = ImageProxyQuery.safeParse(req.query);
    if (!parsed.success) return badBody(res, parsed.error);
    if (!/^https?:/i.test(parsed.data.url) || isUnusablePictureUrl(parsed.data.url)) {
      res.status(422).json({ error: { code: "image_unusable", message: "That address is not a picture Cobblr can show." } });
      return;
    }
    const ctx = tenantContext(req);
    const shown = await fetchShownImage(ctx.org.id, parsed.data.url, guardedImageFetch, parsed.data.page ?? null).catch(() => null);
    if (!shown) {
      res.status(502).json({ error: { code: "image_unavailable", message: "The site did not give that picture." } });
      return;
    }
    res.type(shown.mime);
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Cache-Control", "private, max-age=1800");
    res.send(Buffer.from(shown.bytes));
  }),
);

// "It's this one": an inbox card whose paper is about a thing the workspace
// already has (a bill of sale whose VIN found the car). The paper goes to that
// record the way pasting it there would, its purchase line is claimed for it,
// and the card is done: there is no second car to file.
// AI-REACH: exempt — the inbox card's button; the assistant attaches paperwork to a record through core-scan:attach-paperwork
resolveRouter.post(
  "/inbox/:id/its-this-one",
  asyncHandler(async (req, res) => {
    if (!requireRole(req, res, "owner", "admin", "member")) return;
    const parsed = RecordRef.safeParse(req.body);
    if (!parsed.success) return badBody(res, parsed.error);
    const result = await putPaperworkOn(req, req.params.id ?? "", parsed.data);
    if ("status" in result) {
      res.status(result.status).json({ error: result.error });
      return;
    }
    res.json(result);
  }),
);
