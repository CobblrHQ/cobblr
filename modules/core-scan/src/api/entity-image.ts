// POST /api/v1/orgs/:slug/modules/core-scan/entity-image
// Automatic web image search for an entity (e.g. a 3D printer): search → fetch →
// store → set image_path. Returns the resolved { image_path } (or null) so the
// caller can refetch and show the photo LIVE while the detail modal is open — no
// refresh needed. The user does nothing.

import { Router } from "express";
import { z } from "zod";
import { platform } from "@cobblr/platform-contract";
import { asyncHandler, badBody, requireRole } from "./util.js";
import { bearer, sessionUser, tenantContext, tenantDb } from "../db.js";
import { derivedQueryFor, enrichEntityImage, setEntityImagePath, setMainPhoto, storePickedImage } from "../services/entity-image.js";
import { fileIdOfImagePath, rememberAiPick, rememberSearch, rememberUsed, rememberedSearch, urlInUse } from "../services/record-photo-searches.js";
import { deriveImageQuery } from "../services/ddg-images.js";
import { pictureOptions } from "../services/picture-options.js";
import { needsImage } from "../services/needs-image.js";
import { selectTopCandidates } from "../services/ddg-images.js";
import { isRankFailure, rankFailureSentence, rankPhotoWithAi } from "../services/rank-photo.js";
import { showingFirst, showsTheThing } from "../services/shows-the-thing.js";
import { IMAGE_BUDGET } from "../services/auto-rank.js";

export const entityImageRouter = Router({ mergeParams: true });

const Body = z.object({
  entity_kind: z.string().min(1).max(64),
  entity_id: z.string().min(1).max(100),
  /** Optional: omit it and the phrase is DERIVED from the entity, the same way
   *  the picker and the scan inbox derive it. Callers should omit rather than
   *  hand-build — a hand-built phrase is how "Auto" and "search the web" ended
   *  up finding different things for the same book. */
  query: z.string().min(2).max(200).optional(),
  instance: z.string().max(80).nullable().optional(),
  /** A specific web-image url the user picked (skips auto-search). */
  image_url: z.string().url().max(2000).optional(),
  /** The address of the copy the person SAW for that pick (the strip shows a
   *  search engine's thumbnail). Kept instead when the original will not come. */
  shown_url: z.string().url().max(2000).optional(),
  /** A file ALREADY in this workspace's store (a scan's catalog picture),
   *  handed to the record with no second download. Skips the search too. */
  file_id: z.string().uuid().optional(),
  /** For a picked `image_url`: chosen by the person from the results, or by
   *  AI Pick. Stored on the file with where it was found (photo-source). */
  source: z.enum(["web", "ai_pick"]).optional(),
  source_page: z.string().max(2000).optional(),
  /** The phrase whose results it was picked from. */
  searched: z.string().max(200).optional(),
  reason: z.string().max(600).optional(),
});

// GET /image-options — the universal "search the web for a photo" strip, for
// ANY entity. Three ways to say what to search, in precedence order:
//   entity_kind + entity_id → the phrase is DERIVED from that entity exactly
//     the way the scan inbox derives it (name + brand + its own fields: an
//     author + media word, a colour). This is the one every caller should use:
//     it is why a book searches "… Laura Ingalls Wilder book" on its record
//     page and not a bare title that returns farm scenery.
//   q → a literal phrase (a user-typed term, or a caller with no entity yet).
//     When BOTH are given, q wins — the user asked for exactly that.
// Same pool size + catalog-quality ranking in every case.
const OptionsQuery = z.object({
  q: z.string().max(200).optional(),
  brand: z.string().max(120).optional(),
  entity_kind: z.string().max(64).optional(),
  entity_id: z.string().max(100).optional(),
  /** Search the web again, rather than show the record's last results. */
  fresh: z.enum(["1"]).optional(),
});
entityImageRouter.get(
  "/image-options",
  asyncHandler(async (req, res) => {
    if (!requireRole(req, res, "owner", "admin", "member")) return;
    const parsed = OptionsQuery.safeParse(req.query);
    if (!parsed.success) return badBody(res, parsed.error);
    const { q, brand, entity_kind, entity_id, fresh } = parsed.data;

    // A record's last results, as links (#4515): reopening the panel shows
    // them without searching again, with the photo in use and the AI's pick
    // marked. A typed phrase or Search (`fresh`) asks the web again.
    const remembered = entity_kind && entity_id ? await rememberedSearch(tenantDb(req), entity_kind, entity_id) : null;
    const marks = async () => {
      if (!entity_kind || !entity_id) return {};
      const e = await platform().entities.lookup(tenantContext(req).org.id, entity_kind, entity_id).catch(() => null);
      const imagePath = (e?.image_path ?? (e?.fields as { image_path?: unknown } | undefined)?.image_path ?? null) as string | null;
      return { ai_url: remembered?.ai_url ?? null, ai_reason: remembered?.ai_reason ?? null, in_use_url: urlInUse(remembered, imagePath) };
    };
    if (remembered && remembered.items.length > 0 && !q?.trim() && !fresh) {
      res.json({ items: remembered.items, query: remembered.query, remembered: true, ...(await marks()) });
      return;
    }

    let query: string | null = null;
    let rankBrand: string | null = brand ?? null;
    let subject: { name: string; brand: string | null } | null = null;
    if (entity_kind && entity_id) {
      const derived = await derivedQueryFor(tenantContext(req).org.id, entity_kind, entity_id, q ?? null);
      query = derived.query;
      rankBrand = rankBrand ?? derived.brand;
      // A typed phrase is what the person is looking for; otherwise the record.
      const name = q?.trim() || derived.name;
      if (name) subject = { name, brand: q?.trim() ? null : derived.brand };
    }
    if (!query) query = (q ?? "").trim() || null;
    // Below the useful-search floor (or a junk name) → no options, rather than
    // a strip of nonsense results.
    if (!query || query.length < 2) {
      res.json({ items: [] });
      return;
    }
    // The one pool every strip shows (services/picture-options.ts): engine +
    // library, the shop-less retry, and the engine's refusal REPORTED rather
    // than folded into "nothing found".
    const { items, throttled } = await pictureOptions({ query, brand: rankBrand });
    const shown = subject ? showingFirst(items, subject) : items;
    if (entity_kind && entity_id && shown.length > 0) await rememberSearch(tenantDb(req), entity_kind, entity_id, query, shown);
    res.json({ items: shown, query, throttled, ...(await marks()) });
  }),
);

// AI-REACH: a step of the guided scan/put-away flow, driven from the scanner screen with a camera in hand; the assistant reaches the inbox through list_scan_inbox and the plan through get_putaway_plan
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
    // A file already in the store: point the record at it and stop. This is
    // the "Already tracked" banner handing a scan's picture to the record it
    // matched, which has none.
    const target = {
      orgId: tenantContext(req).org.id,
      orgSlug: slug,
      bearer: token,
      entityKind: parsed.data.entity_kind,
      entityId: parsed.data.entity_id,
      instance: parsed.data.instance ?? null,
    };
    // A file already in the store: make it the main photo and stop. This is
    // the "Already tracked" banner handing a scan's picture to the record it
    // matched, and a picture pasted into the photo search. The photo it
    // replaces stays in the record's photos (setMainPhoto).
    if (parsed.data.file_id) {
      const set = await setMainPhoto({ ...target, fileId: parsed.data.file_id });
      res.json(set ? { ...set, file_id: parsed.data.file_id } : { image_path: null, reason: "The record could not be changed. Try again." });
      return;
    }
    // A picture the person (or AI Pick) picked from the results: keep what
    // they saw, or say why it could not be kept. Never a bare "couldn't save".
    if (parsed.data.image_url) {
      const url = parsed.data.image_url;
      const kept = await storePickedImage(target.orgId, url, parsed.data.shown_url ?? null, {
        kind: parsed.data.source ?? "web",
        original_url: url,
        source_page: parsed.data.source_page ?? null,
        query: parsed.data.searched ?? null,
        reason: parsed.data.reason ?? null,
        at: new Date().toISOString(),
      });
      if (kept.fileId === null) return void res.json({ image_path: null, reason: `${kept.why} Try another picture.` });
      const set = await setMainPhoto({ ...target, fileId: kept.fileId });
      if (!set) return void res.json({ image_path: null, reason: "The picture was saved, but the record could not be changed. Try again." });
      await rememberUsed(tenantDb(req), target.entityKind, target.entityId, url, kept.fileId);
      res.json({ ...set, file_id: kept.fileId });
      return;
    }
    // No explicit query (and no picked url to skip the search)? Derive the
    // phrase from the entity — the SAME derivation the options strip uses, so
    // "Auto" and "search the web" can't disagree about what this thing is.
    let query = parsed.data.query ?? "";
    // What a found picture is judged against: the record itself, or, for a
    // phrase the person typed, exactly what they typed.
    let subject: { name: string | null; brand: string | null } = { name: query || null, brand: null };
    if (!query.trim()) {
      const derived = await derivedQueryFor(
        tenantContext(req).org.id,
        parsed.data.entity_kind,
        parsed.data.entity_id,
      );
      if (!derived.query) {
        // Nothing searchable (a junk/empty name) — say so instead of fetching
        // whatever a bare "Unknown Item" search returns.
        res.json({ image_path: null });
        return;
      }
      query = derived.query;
      subject = { name: derived.name, brand: derived.brand };
    }
    // Await the search + download + set so the caller gets the resolved
    // image_path and can show it live. Bounded (~8s fetch + the search), and
    // best-effort: enrichEntityImage never throws (null on any failure).
    const image_path = await enrichEntityImage({
      orgId: tenantContext(req).org.id,
      orgSlug: slug,
      bearer: token,
      entityKind: parsed.data.entity_kind,
      entityId: parsed.data.entity_id,
      query,
      instance: parsed.data.instance ?? null,
      name: subject.name,
      brand: subject.brand,
    });
    res.json(image_path ? { image_path } : { image_path: null, reason: "No picture found that clearly shows this." });
  }),
);

// POST /entity-image/main: make one of the record's photos its main photo
// (the star on a photo tile), or put back the photo it had (Undo). A file is
// made main through setMainPhoto, which keeps the one it replaces; an older
// outside address, or none, is put back as it was.
const MainBody = z
  .object({
    entity_kind: z.string().min(1).max(64),
    entity_id: z.string().min(1).max(100),
    instance: z.string().max(80).nullable().optional(),
    file_id: z.string().uuid().optional(),
    image_path: z.string().max(2000).nullable().optional(),
  })
  .refine((b) => b.file_id !== undefined || b.image_path !== undefined, { message: "file_id or image_path is required" });
// AI-REACH: exempt — the star on a record's photo tile and its Undo, a person choosing which of their own pictures leads; the assistant sets a record's picture through update_record
entityImageRouter.post(
  "/entity-image/main",
  asyncHandler(async (req, res) => {
    if (!requireRole(req, res, "owner", "admin", "member")) return;
    const parsed = MainBody.safeParse(req.body);
    if (!parsed.success) return badBody(res, parsed.error);
    const token = bearer(req);
    if (!token) return void res.status(401).json({ error: { code: "no_auth", message: "missing bearer" } });
    const slug = req.params.slug;
    if (!slug) return void res.status(400).json({ error: { code: "no_slug", message: "missing slug" } });
    const target = {
      orgId: tenantContext(req).org.id,
      orgSlug: slug,
      bearer: token,
      entityKind: parsed.data.entity_kind,
      entityId: parsed.data.entity_id,
      instance: parsed.data.instance ?? null,
    };
    const fileId = parsed.data.file_id ?? fileIdOfImagePath(parsed.data.image_path);
    if (fileId) {
      const set = await setMainPhoto({ ...target, fileId });
      if (!set) return void res.status(409).json({ error: { code: "not_changed", message: "The record's photo could not be changed. Try again." } });
      return void res.json(set);
    }
    const ok = await setEntityImagePath(target, parsed.data.image_path ?? null);
    if (!ok) return void res.status(409).json({ error: { code: "not_changed", message: "The record's photo could not be changed. Try again." } });
    res.json({ image_path: parsed.data.image_path ?? null, previous_image_path: null });
  }),
);

// POST /entity-image/rank-ai: the scan inbox's "Pick best" for any record.
// The same ranker (rankPhotoWithAi) over the pictures the person is looking
// at, after the same checks a suggestion passes (shows-the-thing.ts): the AI
// chooses among pictures that show the record, never rescues one that does
// not. Runs only when pressed.
const RankBody = z.object({
  entity_kind: z.string().min(1).max(64),
  entity_id: z.string().min(1).max(100),
  candidates: z
    .array(
      z.object({
        url: z.string().url().max(2000),
        thumb: z.string().max(2000).optional(),
        title: z.string().max(300).optional(),
        source: z.string().max(200).optional(),
        width: z.number().int().positive().optional(),
        height: z.number().int().positive().optional(),
      }),
    )
    .min(1)
    .max(24),
});
// AI-REACH: exempt — the record page's Pick best button, a human's display-photo call; it itself calls core-ai, so handing it to the assistant would be circular
entityImageRouter.post(
  "/entity-image/rank-ai",
  asyncHandler(async (req, res) => {
    if (!requireRole(req, res, "owner", "admin", "member")) return;
    const parsed = RankBody.safeParse(req.body);
    if (!parsed.success) return badBody(res, parsed.error);
    const orgId = tenantContext(req).org.id;
    const { entity_kind, entity_id } = parsed.data;
    const derived = await derivedQueryFor(orgId, entity_kind, entity_id);
    const name = derived.name ?? derived.query;
    if (!name || !derived.query) return void res.json({ chosen_url: null, reason: "This record needs a name before photos can be ranked." });
    const pool = parsed.data.candidates.map((c) => ({ url: c.url, thumb: c.thumb ?? "", title: c.title ?? "", source: c.source ?? "", width: c.width, height: c.height }));
    const showing = pool.filter((c) => showsTheThing(c, { name, brand: derived.brand }).ok);
    if (!showing.length) {
      return void res.json({ chosen_url: null, reason: "None of these pictures clearly shows this. Search with other words, or choose one yourself." });
    }
    const result = await rankPhotoWithAi({
      orgId,
      userId: sessionUser(req)?.id ?? null,
      itemId: `${entity_kind}/${entity_id}`,
      itemName: name,
      brand: derived.brand,
      knownColor: null,
      candidates: selectTopCandidates(showing, derived.brand, derived.query, IMAGE_BUDGET),
    });
    if (isRankFailure(result)) return void res.json({ chosen_url: null, reason: rankFailureSentence(result), error: result.error });
    // Remembered with the results, so its AI mark is still on the tile after
    // a reload (#4515).
    if (result.chosenUrl) await rememberAiPick(tenantDb(req), entity_kind, entity_id, result.chosenUrl, result.reason);
    res.json({ chosen_url: result.chosenUrl, reason: result.reason });
  }),
);

// POST /entity-image/backfill — fill in the missing pictures for a whole
// collection in one press, instead of opening each record and clicking Auto.
// Generic over any kind/instance: it lists the collection through the platform
// list seam, takes the ones with no stored image, and runs the SAME derived
// auto-fetch a single record's "Auto" runs.
//
// Detached per record (each is a web search + download), so the request returns
// immediately with how many it started; the pictures appear as they land and
// the client refetches. Idempotent: a record that already has a picture is
// never touched, so pressing it twice is safe and picks up where it left off.
const BackfillBody = z.object({
  entity_kind: z.string().min(1).max(64),
  instance: z.string().max(80).nullable().optional(),
  /** Bounded per press — this spends a web search + download per record. */
  limit: z.number().int().min(1).max(50).optional(),
});
// AI-REACH: a step of the guided scan/put-away flow, driven from the scanner screen with a camera in hand; the assistant reaches the inbox through list_scan_inbox and the plan through get_putaway_plan
entityImageRouter.post(
  "/entity-image/backfill",
  asyncHandler(async (req, res) => {
    if (!requireRole(req, res, "owner", "admin", "member")) return;
    const parsed = BackfillBody.safeParse(req.body);
    if (!parsed.success) return badBody(res, parsed.error);
    const token = bearer(req);
    if (!token) return void res.status(401).json({ error: { code: "no_auth", message: "missing bearer" } });
    const slug = req.params.slug;
    if (!slug) return void res.status(400).json({ error: { code: "no_slug", message: "missing slug" } });
    const orgId = tenantContext(req).org.id;
    const { entity_kind, instance } = parsed.data;
    const limit = parsed.data.limit ?? 25;

    // A generous read window so a big shelf's missing few are found, then the
    // WRITE side is what's capped.
    const listed = await platform()
      .entities.list(orgId, entity_kind, { limit: 500 })
      .catch(() => ({ items: [] as Array<{ id: string; title: string; image_path?: string }> }));
    const targets = needsImage(listed.items, limit);
    const missingTotal = listed.items.filter(
      (i) => !(typeof i.image_path === "string" && i.image_path.trim()),
    ).length;

    // Distinguish WHY a record was skipped. Collapsing these into one count
    // produced a message that blamed the data ("these need a name first") for
    // what was actually a missing resolver registration — the wrong thing to
    // tell someone whose records plainly had names (reported 2026-07-18).
    let started = 0;
    let unresolved = 0; // entities.lookup returned null (a module wiring gap)
    let unnamed = 0; // resolved, but nothing searchable to derive from
    for (const t of targets) {
      const derived = await derivedQueryFor(orgId, entity_kind, t.id);
      if (!derived.query) {
        if (derived.resolved) unnamed++;
        else unresolved++;
        continue;
      }
      started++;
      void enrichEntityImage({
        orgId,
        orgSlug: slug,
        bearer: token,
        entityKind: entity_kind,
        entityId: t.id,
        query: derived.query,
        instance: instance ?? null,
        name: derived.name,
        brand: derived.brand,
      }).catch((err) => console.error("[core-scan] cover backfill failed:", (err as Error).message));
    }
    res.json({
      missing: missingTotal,
      started,
      remaining: Math.max(0, missingTotal - started),
      unnamed,
      unresolved,
    });
  }),
);
