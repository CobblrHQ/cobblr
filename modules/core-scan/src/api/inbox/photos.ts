// A scan's photos (rotate, add, primary, remove), its split and the barcode confirm.
// Split from api/inbox.ts by route group (#7385); inbox.ts mounts the groups in order.
import { Router } from "express";
import { appendScanHistory } from "../../services/scan-history.js";
import { requireCapability } from "@cobblr/platform-contract/action-gate";
import { ocrImageText } from "../../services/ocr.js";
import { applyLabelFacts } from "../../services/label-quantity.js";
import { z } from "zod";
import { platform, countOf } from "@cobblr/platform-contract";
import { splitUncutWords } from "@cobblr/platform-contract/scan-triage";
import { bearer, sessionUser, tenantContext, tenantDb } from "../../db.js";
import { asyncHandler, badBody, requireRole } from "../util.js";
import { isJunkName } from "../../services/enrich.js";
import { intakeRow } from "../../services/intake.js";
import { addedPhotoIntent } from "../../services/crosscheck-policy.js";
import { crossCheckScanPhoto, enrichPhotoItem } from "../../services/enrich-photo.js";
import { mergeMeta } from "../../services/metadata.js";
import { rechoosePictureForColour } from "../../services/withhold-picture.js";
import { redoSplit, undoSplit } from "../../services/undo-split.js";
import { reportBarcodeCorrection, unitLotsOf } from "../../services/barcode-corrections.js";
import { cropRegion, detectSplitItems, rotateImage } from "../../services/image-ops.js";
import { pairPieces, inheritedFields, inheritedMeta, observationFor, type SplitInherited } from "../../services/split-inherit.js";
import { INTERNAL_API, catalogMetaSet, served, storedCandidateList } from "./shared.js";

export const photosRouter = Router({ mergeParams: true });

// ─────────────────────── POST /inbox/:id/rotate ─────────────────────
// Rotate the item's OWN photo (a sideways phone shot). Writes a NEW file and
// swaps it in; the original is kept in metadata.extra_photos — nothing lost.
const RotateBody = z.object({ deg: z.union([z.literal(90), z.literal(180), z.literal(270)]) });
// AI-TOOL: change_scan_item
photosRouter.post(
  "/inbox/:id/rotate",
  asyncHandler(async (req, res) => {
    if (!requireRole(req, res, "owner", "admin", "member")) return;
    const id = req.params.id;
    const parsed = RotateBody.safeParse(req.body);
    if (!parsed.success) return badBody(res, parsed.error);
    const db = tenantDb(req);
    const ctx = tenantContext(req);
    const row = await db
      .selectFrom("core_scan_inbox_items")
      .select(["image_file_id", "suggested_metadata"])
      .where("id", "=", id ?? "")
      .executeTakeFirst();
    if (!row) {
      res.status(404).json({ error: { code: "not_found", message: "inbox item not found" } });
      return;
    }
    if (!row.image_file_id) {
      res.status(400).json({ error: { code: "no_photo", message: "this item has no photo of yours to rotate" } });
      return;
    }
    const newId = await rotateImage(ctx.org.id, row.image_file_id, parsed.data.deg);
    if (!newId) {
      res.status(502).json({ error: { code: "rotate_failed", message: "couldn't read or rewrite the image" } });
      return;
    }
    const meta = (row.suggested_metadata ?? {}) as Record<string, unknown>;
    const extras = Array.isArray(meta.extra_photos) ? (meta.extra_photos as string[]) : [];
    const updated = await db
      .updateTable("core_scan_inbox_items")
      .set({
        image_file_id: newId,
        // extra_photos is single-writer (only the gallery endpoints touch it), so
        // deriving the new array from the snapshot is fine — merge so this write
        // stops dropping the OTHER writers' keys.
        // A rotation is an EDIT of the same photo, not another photo OF the
        // item. Pushing the pre-rotation file into extra_photos "so nothing is
        // lost" meant every tap added a thumbnail to the gallery strip: getting
        // a sideways label upright takes up to three taps and left three
        // near-identical photos behind (reported 2026-08-10). The strip is for
        // genuinely different shots. The pre-rotation id is kept OUT of it,
        // under `rotated_from`, so the original is still recoverable without
        // being displayed as a photo of the item — and the immediate
        // predecessor is dropped from the strip, so rotating again cleans up
        // an intermediate an older build already put there.
        suggested_metadata: mergeMeta({
          rotated_from: (meta.rotated_from as string | undefined) ?? row.image_file_id,
          extra_photos: extras.filter((p) => p !== newId && p !== row.image_file_id),
        }) as never,
        updated_at: new Date(),
      })
      .where("id", "=", id ?? "")
      .returningAll()
      .executeTakeFirstOrThrow();
    res.json(await served(req, updated));
  }),
);

// ─────────────────────── /inbox/:id/photos (gallery) ────────────────
// Multi-photo per item: the primary is image_file_id; extras live in
// metadata.extra_photos (capped 8). Add / make-primary / remove.
// `uploaded` = CHOSEN from the device, not taken just now. See the fork below.
const PhotoBody = z.object({ file_id: z.string().uuid(), uploaded: z.boolean().optional() });
// AI-TOOL: change_scan_item
photosRouter.post(
  "/inbox/:id/photos",
  asyncHandler(async (req, res) => {
    if (!requireRole(req, res, "owner", "admin", "member")) return;
    const id = req.params.id;
    const parsed = PhotoBody.safeParse(req.body);
    if (!parsed.success) return badBody(res, parsed.error);
    const db = tenantDb(req);
    const row = await db
      .selectFrom("core_scan_inbox_items")
      .select(["image_file_id", "suggested_metadata"])
      .where("id", "=", id ?? "")
      .executeTakeFirst();
    if (!row) {
      res.status(404).json({ error: { code: "not_found", message: "inbox item not found" } });
      return;
    }
    const meta = (row.suggested_metadata ?? {}) as Record<string, unknown>;
    const extras = Array.isArray(meta.extra_photos) ? (meta.extra_photos as string[]) : [];
    // No primary yet → the new photo IS the primary; else append to extras.
    const asPrimary = !row.image_file_id;
    const updated = await db
      .updateTable("core_scan_inbox_items")
      .set({
        ...(asPrimary ? { image_file_id: parsed.data.file_id } : {}),
        suggested_metadata: mergeMeta(
          asPrimary
            ? {}
            : { extra_photos: [...extras.filter((p) => p !== parsed.data.file_id), parsed.data.file_id].slice(-8) },
          // Answered - see the catalog-image branch.
          ["photo_wanted"],
        ) as never,
        updated_at: new Date(),
      })
      .where("id", "=", id ?? "")
      .returningAll()
      .executeTakeFirstOrThrow();
    // Adding a photo from the card is the same gesture as the camera "+":
    // EVIDENCE, not decoration. This endpoint used to only file the picture,
    // so the guide's promise ("that picture is what identifies it") was true
    // through the catalog-image door and silently false through this one —
    // complaint 13, reachable from the ⋯ menu. Same fork as the other door:
    // no usable name → the photo names the item; a real name → the check runs
    // behind the picture, flagOnly, so a disagreement is offered with its
    // one-tap fix rather than performed.
    //
    // ...UNLESS IT WAS UPLOADED. A capture is a photo of the object in front of
    // you, so it is evidence about that object. A file off the camera roll is
    // not necessarily a photo of anything: it is routinely a marketplace
    // screenshot, a spec sheet or a receipt kept for the details it carries.
    // Running the cross-check on one asks "does this picture show the named
    // product?" of a web page, which honestly answers no — and the item gets a
    // "this looks wrong" correction offer earned by nothing. So an upload is
    // ATTACHED and nothing more; the card's existing re-identify action is
    // there when the user means it as evidence.
    // Any photo joined to an item is READ as well as kept (#3731): a lot
    // sticker photographed after the item's own barcode says how many there
    // are, which lot and which colourway. Read with the OCR engine, no model;
    // what it finds is written as read from the label, and never over what
    // the person set (services/label-quantity.ts). An upload is read too: a
    // count or a lot printed on it is the same fact, and nothing is taken
    // over the person's own values.
    {
      const readOrg = tenantContext(req).org.id;
      // DETACHED: reading the label's facts; they fill the row when this lands and never overwrite the person's values
      void (async () => {
        const file = await platform().files.read(readOrg, parsed.data.file_id, "original");
        const text = file ? (await ocrImageText(new Uint8Array(file.bytes)))?.text : null;
        if (text?.trim() && (await applyLabelFacts(db as never, updated.id, text))?.fields.colorway) {
          // The label named the colourway: the picture should show it.
          await rechoosePictureForColour(readOrg, db as never, updated.id);
        }
      })().catch((e) => console.error("[core-scan] reading the added photo's label threw:", (e as Error).message));
    }
    if (!parsed.data.uploaded) {
      const orgId = tenantContext(req).org.id;
      const named =
        updated.suggested_name && !isJunkName(updated.suggested_name) ? updated.suggested_name : null;
      if (addedPhotoIntent(!!named) === "offer-correction" && named) {
        // DETACHED: a cross-check of the added photo; it can only flag the row later
        void crossCheckScanPhoto(orgId, updated.id, named, {
          fileId: parsed.data.file_id,
          flagOnly: true,
        }).catch((e) => console.error("[core-scan] added-photo cross-check threw:", (e as Error).message));
      } else {
        // DETACHED: reading the added photo; the row updates when this lands
        void enrichPhotoItem({
          db,
          orgId,
          itemId: updated.id,
          imageFileId: parsed.data.file_id,
          userId: sessionUser(req).id,
          visitorIp: req.ip ?? null,
        }).catch((e) => console.error("[core-scan] added-photo identify threw:", (e as Error).message));
      }
    }
    res.json(await served(req, updated));
  }),
);

// AI-TOOL: change_scan_item
photosRouter.post(
  "/inbox/:id/photos/primary",
  asyncHandler(async (req, res) => {
    if (!requireRole(req, res, "owner", "admin", "member")) return;
    const id = req.params.id;
    const parsed = PhotoBody.safeParse(req.body);
    if (!parsed.success) return badBody(res, parsed.error);
    const db = tenantDb(req);
    const row = await db
      .selectFrom("core_scan_inbox_items")
      .select(["image_file_id", "suggested_metadata", "catalog_image_file_id", "catalog_image_url"])
      .where("id", "=", id ?? "")
      .executeTakeFirst();
    if (!row) {
      res.status(404).json({ error: { code: "not_found", message: "inbox item not found" } });
      return;
    }
    const meta = (row.suggested_metadata ?? {}) as Record<string, unknown>;
    const extras = Array.isArray(meta.extra_photos) ? (meta.extra_photos as string[]) : [];
    if (!extras.includes(parsed.data.file_id)) {
      res.status(400).json({ error: { code: "not_in_gallery", message: "that photo isn't in this item's gallery" } });
      return;
    }
    // IT BECOMES THE DISPLAY IMAGE. That is the CATALOG slot, and only that.
    //
    // Three things live on an item and they are not interchangeable: the photo
    // you scanned (image_file_id, the IDENTIFY photo), what the card displays
    // (catalog_image_*), and the rest of your gallery (extra_photos).
    // /catalog-image states the rule in its own schema — "a freshly-captured
    // upload becomes the DISPLAY (catalog) image; the identify photo is
    // untouched" — and all four of its branches obey it.
    //
    // This one did not. It also wrote image_file_id and moved the displaced
    // identify photo into the gallery, so one tap moved THREE things and read
    // as a swap of two pictures.
    //
    // The undo stack is what makes that indefensible: catalog_history records
    // the catalog slot alone and revert pops exactly that, so an apply touching
    // three could only ever be a third undone. Reported as "it replaced both
    // images ... it undoes one instead of both" (2026-08-17).
    //
    // So: same write as the "use as catalog" door, via the same helper, and the
    // picked photo STAYS in the gallery — removing it would make undo lopsided
    // all over again, stepping the catalog back while the photo itself vanished.
    const updated = await db
      .updateTable("core_scan_inbox_items")
      .set({
        catalog_image_file_id: parsed.data.file_id,
        catalog_image_url: null,
        suggested_metadata: mergeMeta(catalogMetaSet(row, "yours")) as never,
        updated_at: new Date(),
      })
      .where("id", "=", id ?? "")
      .returningAll()
      .executeTakeFirstOrThrow();
    res.json(await served(req, updated));
  }),
);

// AI-TOOL: change_scan_item
photosRouter.delete(
  "/inbox/:id/photos/:fileId",
  asyncHandler(async (req, res) => {
    if (!requireRole(req, res, "owner", "admin", "member")) return;
    const { id, fileId } = req.params;
    const db = tenantDb(req);
    const row = await db
      .selectFrom("core_scan_inbox_items")
      .select(["suggested_metadata"])
      .where("id", "=", id ?? "")
      .executeTakeFirst();
    if (!row) {
      res.status(404).json({ error: { code: "not_found", message: "inbox item not found" } });
      return;
    }
    const meta = (row.suggested_metadata ?? {}) as Record<string, unknown>;
    const extras = Array.isArray(meta.extra_photos) ? (meta.extra_photos as string[]) : [];
    const updated = await db
      .updateTable("core_scan_inbox_items")
      .set({
        suggested_metadata: mergeMeta({ extra_photos: extras.filter((p) => p !== fileId) }) as never,
        updated_at: new Date(),
      })
      .where("id", "=", id ?? "")
      .returningAll()
      .executeTakeFirstOrThrow();
    res.json(await served(req, updated));
  }),
);

// ─────────────────────── POST /inbox/:id/split ──────────────────────
// Split a GROUP photo (one shot of several different things) into separate
// inbox items: vision segments the photo (name + brand + qty + bounding box
// per distinct item), each region is cropped into its own photo, and each
// becomes a child item that runs the normal matchmaker. The parent resolves
// with a "split into N" note (restorable). scan-parity-final-mile.md Epic B.
// AI-REACH: exempt — a model call of its own that crops one photo into
// several items; the assistant does the same through
// core-scan:add-things-from-photo, and core-scan:undo-split takes it back
photosRouter.post(
  "/inbox/:id/split",
  asyncHandler(async (req, res) => {
    if (!requireRole(req, res, "owner", "admin", "member")) return;
    const id = req.params.id;
    const db = tenantDb(req);
    const ctx = tenantContext(req);
    const token = bearer(req);
    const row = await db
      .selectFrom("core_scan_inbox_items")
      .selectAll()
      .where("id", "=", id ?? "")
      .executeTakeFirst();
    if (!row) {
      res.status(404).json({ error: { code: "not_found", message: "inbox item not found" } });
      return;
    }
    if (!row.image_file_id) {
      res.status(400).json({ error: { code: "no_photo", message: "only a photo item can be split" } });
      return;
    }
    const userId = sessionUser(req).id;

    // The group photo's own read is the children's identity: the observation
    // pass (paid for on every photo scan) named each thing, numbers and all,
    // and the parent's candidate carries the fields the router filled. The
    // second call, segmentation, adds boxes so each child can be cut out of
    // the group shot; its names only stand in where the observation named
    // nothing (#2945). Names alone are enough to split: a child with no box
    // keeps the group shot and earns its own product photo by name.
    const parentMeta = (row.suggested_metadata ?? {}) as {
      photo_individuals?: Array<{ name: string; brand: string | null; qty: number }>;
      photo_observations?: string;
      category?: string;
      entity_type?: string;
      series?: string;
    };
    const observed = Array.isArray(parentMeta.photo_individuals) ? parentMeta.photo_individuals : [];
    const detection = await detectSplitItems(ctx.org.id, row.image_file_id, userId);
    const pieces = pairPieces(detection.items, observed);

    if (pieces.length < 2) {
      res.status(409).json({
        error: {
          code: "nothing_to_split",
          message: "The AI sees one item in this photo (or couldn't segment it): nothing to split.",
        },
      });
      return;
    }
    const parentTop = storedCandidateList(row.suggested_candidates)[0] as { fields?: Record<string, unknown> } | undefined;
    const parentFields = parentTop?.fields ?? null;
    const observation = parentMeta.photo_observations ?? null;
    const names = pieces.map((p) => p.name);
    const children: unknown[] = [];
    const cropReport: string[] = [];
    for (const it of pieces) {
      const siblings = names.filter((n) => n !== it.name);
      // Cut from the picture as displayed, and looked at before it is trusted:
      // a flat cut is refused and the child keeps the group shot, with the
      // region recorded so the card can say what was tried.
      const cut = it.box ? await cropRegion(ctx.org.id, row.image_file_id, it.box).catch((): null => null) : null;
      const cropState: "ok" | "failed" | "none" = !it.box ? "none" : cut?.fileId ? "ok" : "failed";
      // Every piece that keeps the group shot says why (scan-triage.ts,
      // scanSplitUncut): a region the cut refused, or no region at all
      // because segmentation did not answer or did not mark this one.
      const cropReason = !it.box
        ? detection.failed
          ? "detect-failed"
          : "not-boxed"
        : cut?.fileId == null
          ? cut && cut.fileId === null
            ? cut.reason
            : "no-source"
          : null;
      cropReport.push(cropState === "ok" ? "ok" : cropState === "failed" ? `failed (${cropReason})` : "no box");
      const ownObservation = observationFor(it, siblings, observation);
      // The parent's whole-photo keys, judged per piece (split-inherit.ts,
      // #3013): the group's series lands only on the piece that names it.
      const meta = inheritedMeta(it, siblings, parentMeta, ownObservation, observation);
      const inherited: SplitInherited = {
        from: row.id,
        name: it.name,
        brand: it.brand,
        fields: inheritedFields(it, siblings, parentFields, observation),
        observation: ownObservation,
        ...(Object.keys(meta.why).length ? { meta_kept: meta.why } : {}),
      };
      const keepsGroupShot = cropState !== "ok";
      const note =
        cropState === "ok"
          ? "Split from a group photo and cropped to this item by vision. Double-check the crop."
          : cropState === "failed"
            ? `Split from a group photo; its crop could not be cut (${splitUncutWords(cropReason ?? "no-source")}), so it keeps the group shot. Crop it to this one, or pick a catalog photo.`
            : `Split from a group photo; it could not be cut out (${splitUncutWords(cropReason)}), so it keeps the group shot. Crop it to this one, or pick a catalog photo.`;
      // The one intake (services/intake.ts, #3049): a split child's plan is
      // its own product photo searched by its own name (matchItem only
      // refetches art when it RENAMES an item, and a child keeps the name
      // the split gave it), then the match.
      const admitted = await intakeRow({
        db,
        orgId: ctx.org.id,
        orgSlug: ctx.org.slug,
        userId,
        token,
        baseUrl: (req.headers["x-cobblr-base-url"] as string | undefined) ?? INTERNAL_API,
        visitorIp: req.ip ?? null,
        door: "split",
        values: {
          source_kind: "photo",
          barcode_text: null,
          source_url: null,
          image_file_id: cut?.fileId ?? row.image_file_id,
          scan_batch_id: row.scan_batch_id,
          scan_area: row.scan_area,
          target_location_id: row.target_location_id,
          created_by_user_id: userId,
          suggested_name: it.name,
          suggested_manufacturer: it.brand,
          quantity: it.qty,
          ai_confidence: "0.6",
          ai_notes: note,
          ai_suggested_at: new Date(),
          suggested_metadata: JSON.stringify({
            source: "vision-split",
            split_from: row.id,
            split_region: it.box,
            ...(it.box_scale ? { split_box_scale: it.box_scale } : {}),
            crop: cropState,
            ...(cropReason ? { crop_reason: cropReason } : {}),
            ...(it.boxed_as && it.boxed_as !== it.name ? { split_boxed_as: it.boxed_as } : {}),
            split_inherited: inherited,
            ...meta.kept,
            ...(Object.keys(meta.dropped).length ? { split_dropped: meta.dropped } : {}),
            // A child on the group shot has already been looked at: the
            // group observation is its observation (keyed to the same image,
            // so the match does not pay to look again), and the sentence
            // about this piece is what the router reads.
            ...(keepsGroupShot && observation
              ? { photo_observations: inherited.observation ?? observation, photo_observed_for: row.image_file_id }
              : {}),
          }) as never,
        } as never,
      });
      const child = admitted.row;
      children.push(child);
    }
    // Parent resolves (restorable) — its photo stays for the audit trail.
    // The note it had is kept beside the split's own, so an undo can put it
    // back word for word; everything else on the row is left as it was.
    await db
      .updateTable("core_scan_inbox_items")
      .set({
        status: "resolved",
        suggested_metadata: mergeMeta({
          split_into: children.map((c) => (c as { id: string }).id),
          split_prior_notes: row.ai_notes ?? null,
          split_how: "photo",
        }) as never,
        ai_notes: `Split into ${countOf(children.length, "item")}.`,
        resolved_at: new Date(),
        updated_at: new Date(),
      })
      .where("id", "=", id ?? "")
      .execute();
    await appendScanHistory(db, id ?? "", { action: "split", note: `${countOf(children.length, "item")}; crops: ${cropReport.join(", ")}` });
    res.json({ children });
  }),
);

// ─────────────────────── POST /inbox/:id/unsplit ────────────────────
// Undo a split (#2945). The parent comes back to the inbox with its data as
// it was before the split: the split changed only its status, its note and
// the split_into record, and each of those goes back; its name, candidates,
// photo and evidence were never touched. The children are soft-discarded,
// never deleted, so what the split produced stays readable. Reachable from
// the parent or from any child (a child resolves to its split_from), since
// the parent sits in the resolved list and the children are what a person
// is looking at when the split turns out wrong. Refused when a child was
// already filed: that record exists now, and putting the group back beside
// it would count the thing twice; send that child back first.
// AI-ACTION: core-scan:undo-split
photosRouter.post(
  "/inbox/:id/unsplit",
  asyncHandler(async (req, res) => {
    if (!(await requireCapability(req, res, "core-scan:undo-split"))) return;
    const id = String(req.params.id);
    const db = tenantDb(req);
    const ctx = tenantContext(req);
    const tok = bearer(req);
    const r = await undoSplit(db, ctx.org.id, id, tok ? { baseUrl: (req.headers["x-cobblr-base-url"] as string | undefined) ?? INTERNAL_API, slug: ctx.org.slug, headers: { Authorization: `Bearer ${tok}`, "Content-Type": "application/json" } } : null);
    if (!r.ok) {
      res.status(r.status).json({ error: r.error });
      return;
    }
    await appendScanHistory(db, r.parent.id, { action: "unsplit", note: `${r.live.length} split item${r.live.length === 1 ? "" : "s"} discarded` });
    res.json({ parent: await served(req, r.parent), discarded: r.live.length });
  }),
);

// ─────────────────────── POST /inbox/:id/redo-split ──────────────────
// Split again (#6527): the Undo split toast's way back. The parts the undo
// took out come back as they were, and the line goes back under them
// (services/undo-split.ts redoSplit). An Undo split is one tap; a stray one
// put the owner's split pack of ten back as one row with no way back but
// splitting it from scratch.
// AI-ACTION: core-scan:redo-split
photosRouter.post(
  "/inbox/:id/redo-split",
  asyncHandler(async (req, res) => {
    if (!(await requireCapability(req, res, "core-scan:redo-split"))) return;
    const db = tenantDb(req);
    const ctx = tenantContext(req);
    const tok = bearer(req);
    const r = await redoSplit(db, String(req.params.id), tok ? { baseUrl: (req.headers["x-cobblr-base-url"] as string | undefined) ?? INTERNAL_API, slug: ctx.org.slug, headers: { Authorization: `Bearer ${tok}`, "Content-Type": "application/json" } } : null);
    if (!r.ok) {
      res.status(r.status).json({ error: r.error });
      return;
    }
    await appendScanHistory(db, r.parent.id, { action: "resplit", note: `${r.parts.length} split item${r.parts.length === 1 ? "" : "s"} back` });
    res.json({ parent: await served(req, r.parent), parts: r.parts });
  }),
);

// ──────────────────── POST /inbox/:id/confirm-barcode ────────────────
// "This listing is good — lock it in." Promote the item's CURRENT resolved
// fields (name / brand / category / catalog image) into the shared Barcode
// Intelligence DB as VERIFIED corrections (a write-token → instant override),
// so every future scan of this UPC — in any workspace — gets this clean entry
// instead of a thin crowdsourced one. Barcode items only (BIdb is UPC-keyed).
// Doesn't touch the item or commit it to inventory — that's the Confirm button.
// AI-REACH: exempt — writes a verified correction into the barcode database
// every workspace reads; one from a chat could change what a code means for
// everyone, so verifying stays a person's press
photosRouter.post(
  "/inbox/:id/confirm-barcode",
  asyncHandler(async (req, res) => {
    if (!requireRole(req, res, "owner", "admin", "member")) return;
    // Curating the SHARED, cross-workspace barcode DB is the platform operator's
    // call, not every member's — a member "locking in" a mislabelled listing
    // poisons every other workspace's future scans of that UPC. The UI already
    // hides this control from non-operators; this is the enforcement so a crafted
    // request can't write to the shared DB either. (The commit-time flywheel and
    // catalog-image picks are separate, user-scoped-benefit paths and unaffected.)
    if (!sessionUser(req).is_platform_admin) {
      res.status(403).json({
        error: {
          code: "operator_only",
          message: "Only the platform operator can lock a listing into the shared barcode database.",
        },
      });
      return;
    }
    const id = req.params.id;
    if (!id) {
      res.status(400).json({ error: { code: "missing_id", message: "id required" } });
      return;
    }
    const db = tenantDb(req);
    const row = await db
      .selectFrom("core_scan_inbox_items")
      .selectAll()
      .where("id", "=", id)
      .executeTakeFirst();
    if (!row) {
      res.status(404).json({ error: { code: "not_found", message: "inbox item not found" } });
      return;
    }
    if (!row.barcode_text) {
      res.status(400).json({ error: { code: "no_barcode", message: "only barcode items can be locked into the barcode database" } });
      return;
    }
    const userId = sessionUser(req).id;
    const meta = (row.suggested_metadata ?? {}) as { category?: unknown };
    const cat = typeof meta.category === "string" ? meta.category : null;
    // Verify each non-blank field (the helper no-ops a blank `now`).
    await Promise.allSettled([
      reportBarcodeCorrection({ upc: row.barcode_text, field: "title", was: row.suggested_name, now: row.suggested_name, userId, confirm: true, lots: unitLotsOf(row.suggested_metadata) }),
      reportBarcodeCorrection({ upc: row.barcode_text, field: "brand", was: row.suggested_manufacturer, now: row.suggested_manufacturer, userId, confirm: true, lots: unitLotsOf(row.suggested_metadata) }),
      reportBarcodeCorrection({ upc: row.barcode_text, field: "category", was: cat, now: cat, userId, confirm: true, lots: unitLotsOf(row.suggested_metadata) }),
      reportBarcodeCorrection({ upc: row.barcode_text, field: "image_url", was: row.catalog_image_url, now: row.catalog_image_url, userId, confirm: true, lots: unitLotsOf(row.suggested_metadata) }),
    ]);
    await appendScanHistory(db, id, { action: "confirm" });
    res.json(await db.selectFrom("core_scan_inbox_items").selectAll().where("id", "=", id).executeTakeFirst());
  }),
);
