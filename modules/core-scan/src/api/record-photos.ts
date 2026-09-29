// The suggested picture for a record made without one (#3818): what a card
// and a record page read, and the three answers a person gives it.

import { Router } from "express";
import { z } from "zod";
import { asyncHandler, badBody, requireRole } from "./util.js";
import { bearer, tenantContext, tenantDb } from "../db.js";
import { kyselyStore, putPictureOn, readAutoApply, recordHasNoPicture, searchAgain, writeAutoApply } from "../services/record-photos.js";
import { imagePathForFile, setEntityImageFile } from "../services/entity-image.js";

export const recordPhotosRouter: Router = Router({ mergeParams: true });

/** A suggestion as a card reads it: the picture to show, and whether it is
 *  still being looked for. */
function served(slug: string, r: { entity_kind: string; entity_id: string; status: string; file_id: string | null; query: string | null }) {
  return {
    entity_kind: r.entity_kind,
    entity_id: r.entity_id,
    status: r.status,
    image_path: r.file_id ? imagePathForFile(slug, r.file_id) : null,
    query: r.query,
  };
}

// A list reads by kind; a record page reads by its id alone, because the page
// may name the base kind ("inventory:part") while an instance's record was
// saved under its own ("yarn:item").
const ListQuery = z
  .object({
    kind: z.string().min(1).max(100).optional(),
    ids: z.string().max(20_000).optional(),
  })
  .refine((q) => !!q.kind || !!q.ids, { message: "kind or ids" });

// GET /photo-suggestions?kind=<kind>[&ids=a,b] — the suggestions a list or a
// record page shows: what is waiting for an answer (suggested), still being
// looked for (queued), or looked for and not found (none), so a card can say
// which. Answered ones are not a card's business.
recordPhotosRouter.get(
  "/photo-suggestions",
  asyncHandler(async (req, res) => {
    const parsed = ListQuery.safeParse(req.query);
    if (!parsed.success) return badBody(res, parsed.error);
    const ids = (parsed.data.ids ?? "").split(",").map((s) => s.trim()).filter(Boolean).slice(0, 500);
    let q = tenantDb(req)
      .selectFrom("core_scan_record_photo_suggestions")
      .select(["entity_kind", "entity_id", "status", "file_id", "query"])
      .where("status", "in", ["suggested", "queued", "none"]);
    if (parsed.data.kind) q = q.where("entity_kind", "=", parsed.data.kind);
    if (ids.length) q = q.where("entity_id", "in", ids);
    const rows = await q.limit(500).execute();
    const slug = tenantContext(req).org.slug;
    res.json({ items: rows.map((r) => served(slug, r)) });
  }),
);

const Target = z.object({ kind: z.string().min(1).max(100), id: z.string().min(1).max(100) });

// AI-REACH: exempt a person answering a picture offered on a record's own card; the assistant sets a record's picture through the record's update
recordPhotosRouter.post(
  "/photo-suggestions/:kind/:id/use",
  asyncHandler(async (req, res) => {
    if (!requireRole(req, res, "owner", "admin", "member")) return;
    const t = Target.safeParse(req.params);
    if (!t.success) return badBody(res, t.error);
    const db = tenantDb(req);
    const ctx = tenantContext(req);
    const row = await db
      .selectFrom("core_scan_record_photo_suggestions")
      .select(["status", "file_id"])
      .where("entity_kind", "=", t.data.kind)
      .where("entity_id", "=", t.data.id)
      .executeTakeFirst();
    if (!row?.file_id || row.status !== "suggested") {
      res.status(404).json({ error: { code: "no_suggestion", message: "There is no suggested picture for this record now." } });
      return;
    }
    // Never over a picture somebody set meanwhile.
    if ((await recordHasNoPicture(ctx.org.id, t.data.kind, t.data.id)) === false) {
      await db.deleteFrom("core_scan_record_photo_suggestions").where("entity_kind", "=", t.data.kind).where("entity_id", "=", t.data.id).execute();
      res.status(409).json({ error: { code: "has_picture", message: "This record has a picture now, so the suggestion was left alone." } });
      return;
    }
    let done = await putPictureOn(ctx.org.id, ctx.org.slug, t.data.kind, t.data.id, row.file_id);
    if (!done) {
      // A kind with no in-process writer is set the way the person would set
      // it: the record's own update route, with their own token.
      const token = bearer(req);
      const [prefix] = t.data.kind.split(":");
      done = !!(token &&
        (await setEntityImageFile({
          orgSlug: ctx.org.slug,
          bearer: token,
          entityKind: t.data.kind,
          entityId: t.data.id,
          instance: t.data.kind.endsWith(":item") ? prefix ?? null : null,
          fileId: row.file_id,
        })));
    }
    if (!done) {
      res.status(422).json({ error: { code: "not_applied", message: "The picture could not be put on this record. Try Show others." } });
      return;
    }
    await db
      .updateTable("core_scan_record_photo_suggestions")
      .set({ status: "applied", updated_at: new Date() })
      .where("entity_kind", "=", t.data.kind)
      .where("entity_id", "=", t.data.id)
      .execute();
    res.json({ ok: true, image_path: imagePathForFile(ctx.org.slug, row.file_id) });
  }),
);

// AI-REACH: exempt a person pressing Search on a record whose picture was not found; the assistant finds a record's picture through the entity-image route
recordPhotosRouter.post(
  "/photo-suggestions/:kind/:id/search",
  asyncHandler(async (req, res) => {
    if (!requireRole(req, res, "owner", "admin", "member")) return;
    const t = Target.safeParse(req.params);
    if (!t.success) return badBody(res, t.error);
    const ctx = tenantContext(req);
    if ((await recordHasNoPicture(ctx.org.id, t.data.kind, t.data.id)) === false) {
      res.status(409).json({ error: { code: "has_picture", message: "This record has a picture now." } });
      return;
    }
    if (!(await searchAgain(ctx.org.id, kyselyStore(tenantDb(req)), t.data.kind, t.data.id))) {
      res.status(404).json({ error: { code: "no_suggestion", message: "This record was never looked up, so there is nothing to search again." } });
      return;
    }
    res.json({ ok: true, status: "queued" });
  }),
);

// AI-REACH: exempt a person turning down a picture offered on a record's card; the assistant has nothing to decline on anyone's behalf
recordPhotosRouter.post(
  "/photo-suggestions/:kind/:id/decline",
  asyncHandler(async (req, res) => {
    if (!requireRole(req, res, "owner", "admin", "member")) return;
    const t = Target.safeParse(req.params);
    if (!t.success) return badBody(res, t.error);
    await tenantDb(req)
      .updateTable("core_scan_record_photo_suggestions")
      .set({ status: "declined", updated_at: new Date() })
      .where("entity_kind", "=", t.data.kind)
      .where("entity_id", "=", t.data.id)
      .execute();
    res.json({ ok: true });
  }),
);

recordPhotosRouter.get(
  "/photo-suggest-config",
  asyncHandler(async (req, res) => {
    res.json({ auto_apply: await readAutoApply(tenantDb(req)) });
  }),
);

const ConfigBody = z.object({ auto_apply: z.boolean() });

// AI-REACH: exempt a workspace setting on the AI page's photos section; the assistant does not change a workspace's settings
recordPhotosRouter.put(
  "/photo-suggest-config",
  asyncHandler(async (req, res) => {
    if (!requireRole(req, res, "owner", "admin")) return;
    const parsed = ConfigBody.safeParse(req.body);
    if (!parsed.success) return badBody(res, parsed.error);
    await writeAutoApply(tenantDb(req), parsed.data.auto_apply);
    res.json({ auto_apply: parsed.data.auto_apply });
  }),
);
