// The suggested picture for a record made without one (#3818): what a card
// and a record page read, and the three answers a person gives it.

import { Router } from "express";
import { z } from "zod";
import { asyncHandler, badBody, requireRole } from "./util.js";
import { bearer, tenantContext, tenantDb } from "../db.js";
import { kyselyStore, nudge, oneRowPerRecord, putPictureOn, readAutoApply, readSuggestOn, recordHasNoPicture, searchAgain, writeAutoApply, writeSuggestOn } from "../services/record-photos.js";
import { fetchImage, imagePathForFile, setEntityImageFile, storeFetchedImage } from "../services/entity-image.js";
import { heldColumns, heldPicture } from "../services/held-picture.js";

export const recordPhotosRouter: Router = Router({ mergeParams: true });

/** Where a held suggestion's picture is served from: the suggestion store,
 *  never Files (#7447). */
export function heldPicturePath(slug: string, kind: string, id: string): string {
  return `/api/v1/orgs/${slug}/modules/core-scan/photo-suggestions/${encodeURIComponent(kind)}/${encodeURIComponent(id)}/picture`;
}

/** A suggestion as a card reads it: the picture to show, and whether it is
 *  still being looked for. A held picture is served from the suggestion
 *  store; a file only once it was used (or, on a workspace from before #7447
 *  the heal has not reached yet, the file it was stored as). A suggestion
 *  whose preview outlived its days (#8941) is served from the same address,
 *  which fetches it again from where it was found. */
function served(slug: string, r: { entity_kind: string; entity_id: string; status: string; file_id: string | null; held: unknown; refetch: unknown; query: string | null }) {
  const yes = (v: unknown) => v === true || v === 1;
  return {
    entity_kind: r.entity_kind,
    entity_id: r.entity_id,
    status: r.status,
    image_path: yes(r.held) ? heldPicturePath(slug, r.entity_kind, r.entity_id) : r.file_id ? imagePathForFile(slug, r.file_id) : r.status === "suggested" && yes(r.refetch) ? heldPicturePath(slug, r.entity_kind, r.entity_id) : null,
    query: r.query,
  };
}

// A list reads by kind; a record page reads by its id alone, because the page
// may name the base kind ("inventory:part") while an instance's record was
// saved under its own ("yarn:item").
/** Records one lookup may name: a collection's page of cards, with room. */
export const LOOKUP_MAX_IDS = 5_000;

const LookupBody = z
  .object({
    kind: z.string().min(1).max(100).optional(),
    ids: z.array(z.string().min(1).max(100)).max(LOOKUP_MAX_IDS).optional(),
  })
  .refine((q) => !!q.kind || !!q.ids?.length, { message: "kind or ids" });

/** The pre-#4653 address, kept for a page loaded before the update: the ids
 *  rode in the query string, which a proxy refuses once the list is long. */
const ListQuery = z
  .object({
    kind: z.string().min(1).max(100).optional(),
    ids: z.string().max(20_000).optional(),
  })
  .refine((q) => !!q.kind || !!q.ids, { message: "kind or ids" });

/** What a list or a record page shows, one row per record: waiting for an
 *  answer (suggested), still being looked for (queued), or looked for and not
 *  found (none). Answered ones are not a card's business. */
async function lookup(req: Parameters<typeof tenantDb>[0], kind: string | undefined, ids: readonly string[]) {
  let q = tenantDb(req)
    .selectFrom("core_scan_record_photo_suggestions")
    .select((eb) => ["entity_kind", "entity_id", "status", "file_id", "query", "updated_at", eb("held_bytes", "is not", null).as("held"), eb("source_url", "is not", null).as("refetch")])
    .where("status", "in", ["suggested", "queued", "none"]);
  // A list asks by its kind AND names the records it shows: a record's row
  // may sit under another kind name (a collection's item is its module's
  // record too), and it is still this list's record.
  if (kind && ids.length) q = q.where((eb) => eb.or([eb("entity_kind", "=", kind), eb("entity_id", "in", ids)]));
  else if (kind) q = q.where("entity_kind", "=", kind);
  else q = q.where("entity_id", "in", [...ids]);
  // list-cap-ok: bounded by the records the list names (LOOKUP_MAX_IDS), or by kind at the same cap
  const rows = await q.limit(LOOKUP_MAX_IDS * 2).execute();
  const slug = tenantContext(req).org.slug;
  return { items: oneRowPerRecord(rows).map((r) => served(slug, r)) };
}

// POST /photo-suggestions/lookup {kind?, ids?}: the ids ride in the body, so
// a collection of thousands asks in one request (#4653: the query-string
// form was refused with 414 URI Too Long on a large collection's page).
// AI-REACH: exempt a list reading the picture states of the cards it shows; the assistant reads a record's picture through the record
recordPhotosRouter.post(
  "/photo-suggestions/lookup",
  asyncHandler(async (req, res) => {
    const parsed = LookupBody.safeParse(req.body);
    if (!parsed.success) return badBody(res, parsed.error);
    const ids = [...new Set((parsed.data.ids ?? []).map((s) => s.trim()).filter(Boolean))];
    res.json(await lookup(req, parsed.data.kind, ids));
  }),
);

recordPhotosRouter.get(
  "/photo-suggestions",
  asyncHandler(async (req, res) => {
    const parsed = ListQuery.safeParse(req.query);
    if (!parsed.success) return badBody(res, parsed.error);
    const ids = (parsed.data.ids ?? "").split(",").map((s) => s.trim()).filter(Boolean).slice(0, 500);
    res.json(await lookup(req, parsed.data.kind, ids));
  }),
);

const Target = z.object({ kind: z.string().min(1).max(100), id: z.string().min(1).max(100) });

// GET /photo-suggestions/:kind/:id/picture: the picture a suggestion holds,
// from the suggestion store (#7447). Nothing about it is in Files. A preview
// that outlived its days is fetched again from where it was found (#8941).
recordPhotosRouter.get(
  "/photo-suggestions/:kind/:id/picture",
  asyncHandler(async (req, res) => {
    const t = Target.safeParse(req.params);
    if (!t.success) return badBody(res, t.error);
    const pic = await heldPicture(tenantDb(req), t.data.kind, t.data.id, async (url) => (await fetchImage(url)).image);
    if (!pic) {
      res.status(404).json({ error: { code: "no_picture", message: "This suggestion holds no picture now." } });
      return;
    }
    res.setHeader("Content-Type", pic.mimeType || "image/jpeg");
    res.setHeader("Cache-Control", "private, max-age=300");
    res.send(Buffer.from(pic.bytes));
  }),
);

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
      .select(["status", "file_id", "held_bytes", "held_type", "held_name", "source_url", "query"])
      .where("entity_kind", "=", t.data.kind)
      .where("entity_id", "=", t.data.id)
      .executeTakeFirst();
    if (!row || row.status !== "suggested" || (!row.held_bytes && !row.file_id && !row.source_url)) {
      res.status(404).json({ error: { code: "no_suggestion", message: "There is no suggested picture for this record now." } });
      return;
    }
    // Never over a picture somebody set meanwhile.
    if ((await recordHasNoPicture(ctx.org.id, t.data.kind, t.data.id)) === false) {
      await db.deleteFrom("core_scan_record_photo_suggestions").where("entity_kind", "=", t.data.kind).where("entity_id", "=", t.data.id).execute();
      res.status(409).json({ error: { code: "has_picture", message: "This record has a picture now, so the suggestion was left alone." } });
      return;
    }
    // Use it is what makes the file (#7447). A suggestion holds only a
    // preview (#8941), so the picture is fetched whole from where it was
    // found; a site that no longer gives it leaves the preview the card
    // showed. A suggestion from before the heal still names its file.
    const whole = !row.file_id && row.source_url ? (await fetchImage(row.source_url)).image : null;
    const picture = whole ?? (row.held_bytes ? { bytes: new Uint8Array(row.held_bytes), mimeType: row.held_type || "image/jpeg", filename: row.held_name || "picture.jpg" } : null);
    const fileId = picture
      ? await storeFetchedImage(ctx.org.id, picture, { kind: "web", original_url: row.source_url ?? "", ...(row.query ? { query: row.query } : {}), at: new Date().toISOString() }).catch(() => null)
      : row.file_id;
    if (!fileId) {
      res.status(422).json({ error: { code: "not_applied", message: "The picture could not be kept. Try Show others." } });
      return;
    }
    let done = await putPictureOn(ctx.org.id, ctx.org.slug, t.data.kind, t.data.id, fileId);
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
          fileId,
        })));
    }
    if (!done) {
      res.status(422).json({ error: { code: "not_applied", message: "The picture could not be put on this record. Try Show others." } });
      return;
    }
    await db
      .updateTable("core_scan_record_photo_suggestions")
      .set({ status: "applied", file_id: fileId, ...heldColumns(null), updated_at: new Date() })
      .where("entity_kind", "=", t.data.kind)
      .where("entity_id", "=", t.data.id)
      .execute();
    res.json({ ok: true, image_path: imagePathForFile(ctx.org.slug, fileId) });
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
      // No thanks keeps nothing: the held picture goes with it (#7447).
      .set({ status: "declined", ...heldColumns(null), updated_at: new Date() })
      .where("entity_kind", "=", t.data.kind)
      .where("entity_id", "=", t.data.id)
      .execute();
    res.json({ ok: true });
  }),
);

recordPhotosRouter.get(
  "/photo-suggest-config",
  asyncHandler(async (req, res) => {
    const db = tenantDb(req);
    res.json({ suggest_on: await readSuggestOn(db), auto_apply: await readAutoApply(db) });
  }),
);

const ConfigBody = z.object({ suggest_on: z.boolean().optional(), auto_apply: z.boolean().optional() });

// AI-REACH: exempt a workspace setting on the AI page's photos section; the assistant does not change a workspace's settings
recordPhotosRouter.put(
  "/photo-suggest-config",
  asyncHandler(async (req, res) => {
    if (!requireRole(req, res, "owner", "admin")) return;
    const parsed = ConfigBody.safeParse(req.body);
    if (!parsed.success) return badBody(res, parsed.error);
    const db = tenantDb(req);
    if (parsed.data.suggest_on !== undefined) await writeSuggestOn(db, parsed.data.suggest_on);
    if (parsed.data.auto_apply !== undefined) await writeAutoApply(db, parsed.data.auto_apply);
    // Turned on: the existing records are queued and looked at soon, not at
    // the next idle round.
    if (parsed.data.suggest_on) nudge(tenantContext(req).org.id);
    res.json({ suggest_on: await readSuggestOn(db), auto_apply: await readAutoApply(db) });
  }),
);
