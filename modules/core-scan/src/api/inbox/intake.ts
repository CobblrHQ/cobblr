// Scans coming in: a code, a typed note, the assistant's text and photo, an order line, paperwork.
// Split from api/inbox.ts by route group (#7385); inbox.ts mounts the groups in order.
import { Router } from "express";
import { appendScanHistory } from "../../services/scan-history.js";
import { requireCapability } from "@cobblr/platform-contract/action-gate";
import { withSellersApart } from "../../services/seller-split.js";
import { placeAgentFields, sellerInName, thingInName } from "../../services/agent-fields.js";
import { ARRIVED_BY_KEY } from "../../services/photo-observation-gate.js";
import { applySharedTitle } from "../../services/shared-title.js";
import { pictureHash, recentTwin } from "../../services/same-picture.js";
import { applyUserFieldPatch } from "../../services/user-fields.js";
import { listNamedByCategory } from "../../services/retarget-by-category.js";
import { type Request } from "express";
import { sql } from "kysely";
import { attachPaperwork } from "../../services/attach-paperwork.js";
import { takePaperworkValue, undoPaperworkFill } from "../../services/record-paperwork.js";
import { amountOf, centsFromAmount } from "@cobblr/platform-contract/money";
import { z } from "zod";
import { platform, countOf } from "@cobblr/platform-contract";
import { roleSatisfies } from "@cobblr/platform-contract/org-roles";
import { BundleInstaller, fileThroughConfirm } from "../../services/file-through-confirm.js";
import { SCAN_PURPOSES, type ScanResolverTable, DESTINATION_KEY, type StoredDestination } from "@cobblr/platform-contract/scan-triage";
import { bearer, sessionUser, tenantContext, tenantDb } from "../../db.js";
import { asyncHandler, badBody, requireRole } from "../util.js";
import { noteScanCaptured } from "../../services/activation.js";
import { enrichBarcodeItem } from "../../services/enrich.js";
import { inboxRowByCode, intakeRow, knownByCode, typedIdentifier, type InsertValues } from "../../services/intake.js";
import { crossCheckScanPhoto } from "../../services/enrich-photo.js";
import { mergeMeta } from "../../services/metadata.js";
import { type TrackedMatchStamp } from "../../services/tracked-stamp.js";
import { destinationTables, filingDestination } from "../../services/destination.js";
import { assembleScanMenu, type ScanMenuEntry } from "../../services/matchmaker.js";
import { splitParentsOf } from "../../services/split-groups.js";
import { cropRegion, cropRefusalWords, detectSplitItems } from "../../services/image-ops.js";
import { allBoxed, countMismatchSentence, placeListed, type ListedPiece } from "../../services/listed-pieces.js";
import { storeCodeInsertStamps } from "../../services/barcode-lookup.js";
import { FIELD_PROVENANCE_KEY, fieldProvenanceOf, type FieldProvenanceMap } from "@cobblr/platform-contract/acquisition-source";
import { applyPersonName, withPersonName } from "../../services/user-name.js";
import { extractLocation, type LocationLite } from "../../services/note-location.js";
import { optionalField, optionalText, optionalUuid } from "@cobblr/platform-contract/optional-fields";
import { INTERNAL_API, RecordRef, agentFieldsFor, destinationTablesFor, liveTablesFor, paperworkHttp, served } from "./shared.js";

export const intakeRouter = Router({ mergeParams: true });

// ─────────────────────────── POST /scan ────────────────────────────

const ScanBody = z.object({
  purpose: z.enum(SCAN_PURPOSES).default("arrival"),
  barcode: optionalField(z.string().min(4).max(64)),
  source_kind: z.enum(["barcode", "photo", "url", "receipt"]).default("barcode"),
  source_url: optionalField(z.string().url().max(2000)),
  /** The product's title as the person shared or pasted it with the link
   *  (parseSharedText, @cobblr/platform-contract/shared-text). Kept as the
   *  item's name, before and after enrichment: a shop page that blocks us
   *  cannot take away a name the person brought. */
  shared_title: optionalField(z.string().trim().min(1).max(300)),
  image_file_id: optionalUuid(),
  scan_batch_id: optionalUuid(),
  scan_area: optionalText(200),
  /** The picture arrived by email (an attachment the mail door filed), not
   *  from the person's camera or upload. Stamped on the row as `arrived_by`:
   *  an emailed image is never kept as an example (photo-observation-gate). */
  origin: optionalField(z.enum(["email"])),
  /** The active filing location ("bin") for this scan session — a
   *  core-locations node. Stamped on the item so confirm files the created
   *  entity into that location without re-picking. The active-bin pattern. */
  target_location_id: optionalUuid(),
  /** Scan-into-container: the active bin is a container ENTITY (a server asset,
   *  a machine) rather than a location. Confirm places the created item inside
   *  it (a placement) instead of stamping location_id. */
  target_container_kind: optionalText(120),
  target_container_id: optionalText(200),
  capture_id: optionalUuid(),
  /** Per-scan budget for the inline enrichment race. After this
   *  the response returns the bare row and enrichment continues
   *  detached. Default 12s. */
  enrich_ms: optionalField(z.number().int().positive().max(30_000)),
  /** The same picture was just added: add it again anyway. Without it, a
   *  repeat within the window answers with the existing item (#3852). */
  allow_duplicate: z.boolean().optional(),
});

/** What a decoded code already is here, from the workspace's own records
 *  only (#6436). The scanner asks this the instant a code decodes and shows
 *  the record at once, while the photo and the scan itself are still on their
 *  way; an outside lookup is only ever for a code this answers null to.
 *  Writes nothing. */
intakeRouter.get(
  "/scan/known",
  asyncHandler(async (req, res) => {
    if (!requireRole(req, res, "owner", "admin", "member")) return;
    const code = typeof req.query.code === "string" ? req.query.code.trim().slice(0, 200) : "";
    if (!code) return void res.status(400).json({ error: { code: "bad_query", message: "Say which code (code=)." } });
    const purpose = typeof req.query.purpose === "string" && ["arrival", "count", "move", "sort"].includes(req.query.purpose) ? req.query.purpose : "arrival";
    // A row still in the inbox wins over a record (#6554): it is the newer
    // intent, and the scan that follows lands on it. The record still says
    // "You already have this" beside it.
    const [known, row] = await Promise.all([knownByCode(tenantContext(req).org.id, code), inboxRowByCode(tenantDb(req) as never, code, purpose)]);
    res.json({ known, inbox_row: row ? await served(req, row as never) : null });
  }),
);

// AI-REACH: exempt — the scanner's intake of a code or photo the camera just
// read; the assistant adds a thing through add_thing, the same intake by words
intakeRouter.post(
  "/scan",
  asyncHandler(async (req, res) => {
    if (!requireRole(req, res, "owner", "admin", "member")) return;
    const parsed = ScanBody.safeParse(req.body);
    if (!parsed.success) return badBody(res, parsed.error);
    const body = parsed.data;

    // Require SOMETHING to identify from. A barcode takes the fast path
    // (catalog lookup → web-search fallback); a photo with no barcode takes the
    // vision path (core-ai identify-image), fired detached below so intake
    // stays instant; a source_url is read by the URL branch further down.
    //
    // `source_url` belongs in this list and was missing from it, which made
    // every URL scan a 400 before the branch that handles it could run -
    // pasting a product link into the scan box added nothing (reported
    // 2026-08-12). The guard predates URL intake and was never widened when it
    // landed, so the feature was unreachable through this route from the start.
    if (!body.barcode && !body.image_file_id && !body.source_url) {
      res.status(400).json({
        error: {
          code: "no_input",
          message: "scan needs at least a barcode, an image_file_id or a source_url",
        },
      });
      return;
    }

    const db = tenantDb(req);
    const ctx = tenantContext(req);
    const session = sessionUser(req);

    if (body.capture_id) {
      const prior = await db.selectFrom("core_scan_inbox_items").selectAll().where("id", "=", body.capture_id).executeTakeFirst();
      if (prior) { res.status(200).json(prior); return; }
    }

    // Create-time defaults: a module (e.g. presence) may default scan_area from
    // context — the room the user is physically in. The seam is provider-
    // agnostic and inert when nothing's registered; the client's explicit
    // scan_area always wins over a default.
    const defaults = await platform().entities.resolveCreateDefaults({
      orgId: ctx.org.id,
      userId: session.id,
      kind: "core-scan:item",
      supplied: { scan_area: body.scan_area },
    });
    const scanArea =
      body.scan_area ??
      (typeof defaults.scan_area === "string" ? defaults.scan_area : null);

    // Dedup repeated scans of the SAME barcode and purpose: rather than
    // pile up a new row per scan, bump the quantity on the pending entry that's
    // already there. Checks only resurface; arrivals increase the quantity.
    // Dedup is GLOBAL across pending items for that barcode and purpose —
    // NOT scoped to a batch/area (batch-scoping let the same UPC pile up a fresh
    // row per session, which is exactly how items went "missing": a re-scan in a
    // new session created a duplicate instead of resurfacing the one you had).
    // The matched item is re-assigned to the CURRENT session + bumped to the top.
    // Only for barcode scans (photos/notes/receipts are each distinct); a re-scan
    // after commit/dismiss starts fresh — we only match `pending`.
    if (body.source_kind === "barcode" && body.barcode && !body.capture_id) {
      const hasPhoto = !!body.image_file_id;
      // Preferred match when this scan carries a PHOTO: an existing pending entry
      // for the SAME UPC that still has no photo — even in another batch/session.
      // "I scanned this, the name came back wrong, here's a photo to fix it" should
      // enrich the prior scan, not pile up a second row. Same-batch first, else the
      // most recent photoless one anywhere.
      const relinkTarget = hasPhoto
        ? await db
            .selectFrom("core_scan_inbox_items")
            .select(["id", "suggested_name", "image_file_id"])
            .where("status", "=", "pending")
            .where("barcode_text", "=", body.barcode)
          .where(sql<string>`coalesce(suggested_metadata->>'scan_purpose', 'arrival')`, "=", body.purpose)
            .where("image_file_id", "is", null)
            .orderBy(
              sql`(scan_batch_id is not distinct from ${body.scan_batch_id ?? null})`,
              "desc",
            )
            .orderBy("created_at", "desc")
            .executeTakeFirst()
        : null;
      // Otherwise the most-recent pending entry for this barcode, ANYWHERE (no
      // batch/area filter — see the note above). Re-scanning the same code always
      // resurfaces the single row you already have.
      const existing =
        relinkTarget ??
        (await db
          .selectFrom("core_scan_inbox_items")
          .select(["id", "suggested_name", "image_file_id"])
          .where("status", "=", "pending")
          .where("barcode_text", "=", body.barcode)
          .where(sql<string>`coalesce(suggested_metadata->>'scan_purpose', 'arrival')`, "=", body.purpose)
          .orderBy("created_at", "desc")
          .executeTakeFirst());
      if (existing) {
        // Attach this scan's photo to the entry if it didn't have one (the re-scan
        // is "more info" for the same item, not a duplicate).
        const attachPhoto = hasPhoto && !existing.image_file_id;
        const bumped = await db
          .updateTable("core_scan_inbox_items")
          .set({
            quantity: body.purpose === "arrival" ? sql`quantity + 1` : sql`quantity`,
            ...(attachPhoto ? { image_file_id: body.image_file_id } : {}),
            // Move the item into the session it was just re-scanned in, and stamp
            // the area if this scan carried one — so it groups with the scans
            // around it (batchId is re-assigned on a deduped re-scan too). Leave
            // them untouched when the scan didn't specify (no session / no area).
            ...(body.scan_batch_id ? { scan_batch_id: body.scan_batch_id } : {}),
            ...(scanArea ? { scan_area: scanArea } : {}),
            // Re-scanning a UPC means "I'm looking at this again" — re-queue it to
            // the TOP of the inbox. The list sorts by created_at desc, so without
            // this the deduped row stays buried at its original position and the
            // user (reasonably) thinks the scan did nothing / went missing.
            created_at: sql`now()`,
            updated_at: sql`now()`,
          })
          .where("id", "=", existing.id)
          .returningAll()
          .executeTakeFirstOrThrow();
        void platform().events.emit("core-scan.scan.received", {
          orgId: ctx.org.id,
          visitor_ip: req.ip ?? null,
          itemId: bumped.id,
          barcode: body.barcode,
          sourceKind: "barcode",
        });
        const token = bearer(req);
        const baseUrl = (req.headers["x-cobblr-base-url"] as string | undefined) ?? INTERNAL_API;
        if (!bumped.suggested_name && body.barcode && token) {
          // Re-scanning a still-UNIDENTIFIED item means "try again" — re-run
          // enrichment instead of leaving it frozen. enrichBarcodeItem
          // cross-checks the (now-attached) photo against the resolved name itself.
          // `force` (skip both cache tiers, pay a fresh provider round) only when
          // the last attempt is STALE: the natural rapid double-beep on a
          // stubborn code used to multiply provider calls — 10 quick re-scans
          // was up to 10 forced rounds against a shared quota.
          const lastTry = bumped.ai_suggested_at ? new Date(bumped.ai_suggested_at as unknown as string).getTime() : 0;
          // DETACHED: identifying the scan; the row shows it is still being read and updates when this lands
          void enrichBarcodeItem({
            db,
            orgId: ctx.org.id,
            itemId: bumped.id,
            orgSlug: ctx.org.slug,
            bearer: token,
            baseUrl,
            upc: body.barcode,
            force: Date.now() - lastTry > 60_000,
          })
            .catch((err) => console.error("[core-scan] re-scan re-enrich threw:", (err as Error).message))
            .then(() =>
              platform().events.emit("core-scan.scan.enriched", { orgId: ctx.org.id, itemId: bumped.id }),
            );
        } else if (attachPhoto && bumped.suggested_name) {
          // Already named, and we just gave it a photo → run the barcode-vs-photo
          // cross-check. No flagOnly here, deliberately: a scan-moment photo is
          // the strongest evidence about the object in hand, so an image-basis
          // mismatch with a confident read RENAMES (and votes) rather than
          // merely flagging — the evidence-model treatment for this door.
          // DETACHED: a cross-check of the re-scan's photo; it can only flag or rename the row later
          void crossCheckScanPhoto(ctx.org.id, bumped.id, bumped.suggested_name).catch((err) =>
            console.error("[core-scan] re-scan cross-check threw:", (err as Error).message),
          );
        }
        res.status(200).json(bumped);
        return;
      }
    }

    // The same picture pasted twice is one item (services/same-picture.ts,
    // #3852): a repeat within the window is answered with the item it
    // already made, and the person may still ask for another copy.
    const imageHash = body.source_kind === "photo" && body.image_file_id ? await pictureHash(ctx.org.id, body.image_file_id) : null;
    if (imageHash && !body.allow_duplicate) {
      const twin = await recentTwin(db, imageHash, new Date(), body.purpose);
      if (twin) {
        const existing = await db.selectFrom("core_scan_inbox_items").selectAll().where("id", "=", twin.id).executeTakeFirstOrThrow();
        res.status(200).json({ ...(await served(req, existing)), duplicate_of_recent: true });
        return;
      }
    }

    noteScanCaptured(ctx.org.id, session.id, body.source_kind);
    // A store's own label is known from its prefix: its verdict, its reason
    // and its "done" stamp go on at insert, so the scanner's sheet reads the
    // row's state on the first paint instead of "Identifying..." (#3017).
    const storeStamps = storeCodeInsertStamps(body.barcode);
    const token = bearer(req);
    const emailed = { scan_purpose: body.purpose, ...(body.origin === "email" ? { [ARRIVED_BY_KEY]: "email" } : {}) };
    // A title shared with the link is the person's name for the row, kept
    // like a rename (services/shared-title.ts).
    const arrivedBy = body.shared_title ? applySharedTitle(emailed, body.shared_title) : emailed;
    // The one intake (services/intake.ts, #3049): the insert, the shape's
    // passes in their order (the catalog chain raced inline for a barcode
    // within the budget, the photo wire, the match once a name exists), and
    // the received event. This door adds nothing to the plan.
    const admitted = await intakeRow({
      db,
      orgId: ctx.org.id,
      orgSlug: ctx.org.slug,
      userId: session.id,
      token,
      baseUrl: (req.headers["x-cobblr-base-url"] as string | undefined) ?? INTERNAL_API,
      visitorIp: req.ip ?? null,
      door: "scan",
      values: {
        ...(body.capture_id ? { id: body.capture_id } : {}),
        source_kind: body.source_kind,
        barcode_text: body.barcode ?? null,
        source_url: body.source_url ?? null,
        image_file_id: body.image_file_id ?? null,
        scan_batch_id: body.scan_batch_id ?? null,
        scan_area: scanArea,
        target_location_id: body.target_location_id ?? null,
        target_container_kind: body.target_container_kind ?? null,
        target_container_id: body.target_container_id ?? null,
        created_by_user_id: session.id,
        ...(storeStamps
          ? {
              ai_notes: storeStamps.ai_notes,
              ai_confidence: storeStamps.ai_confidence,
              ai_suggested_at: storeStamps.ai_suggested_at,
              suggested_metadata: JSON.stringify({ code_type: storeStamps.code_type, ...arrivedBy }) as never,
            }
          : imageHash
            ? { suggested_metadata: JSON.stringify({ image_sha256: imageHash, ...arrivedBy }) as never }
            : Object.keys(arrivedBy).length > 0
              ? { suggested_metadata: JSON.stringify(arrivedBy) as never }
              : {}),
        ...(body.shared_title ? { suggested_name: body.shared_title } : {}),
      },
      // Race inline enrichment against the budget. Whichever lands first
      // wins the response; the other keeps running detached.
      inlineBudgetMs: body.enrich_ms ?? 12_000,
    });
    const inserted = admitted.row;
    // Re-acquire the tenant DB for the read-back. A slow inline enrichment
    // (go-upc's website fetch, the web-search/vision floor) leaves the pool
    // idle long enough that the idle reaper (`releaseIdleTenantPool`) can
    // `pool.end()` the handle captured at the top of this request — reusing it
    // then throws "Cannot use a pool after calling end on the pool". getDb
    // returns the live cached pool, or transparently re-opens an evicted one.
    const freshDb = (await platform().tenants.getDb(ctx.org.id)) as unknown as typeof db;
    const fresh = await freshDb
      .selectFrom("core_scan_inbox_items")
      .selectAll()
      .where("id", "=", inserted.id)
      .executeTakeFirstOrThrow();

    // Served like every other row: the scanner's sheet reads this response
    // first and the row's state must be on it (review_reason, tool_hints),
    // not only on the poll that follows (#3017).
    res.status(201).json(await served(req, fresh));
  }),
);

// ─────────────────────────── POST /scan/note ───────────────────────
// Capture-first "write something down": free text the user typed, with ZERO
// structure set up. The text IS the perceived item — the matchmaker routes it
// against the merged menu (the flagship bundle shapes on a blank workspace) and
// extracts fields, exactly like a scan. No enrichment to wait for, so the match
// fires immediately + detached; the web polls /inbox for the suggestion.

const NoteBody = z.object({
  text: z.string().trim().min(1).max(2000),
  scan_batch_id: optionalUuid(),
  scan_area: optionalText(200),
  /** Explicit pre-filed location (the picker, or an integration that already
   *  resolved one). When set it wins over text extraction. */
  target_location_id: optionalUuid(),
});

/** The workspace's place with this name (the note door's own match); null
 *  when it has none; undefined when the places could not be read, which is
 *  not the same as there being none. */
async function placeNamed(orgId: string, said: string): Promise<string | null | undefined> {
  try {
    const locs = await platform().entities.list(orgId, "core-locations:location", { limit: 1000 });
    const lite: LocationLite[] = locs.items.map((l) => ({
      id: String(l.id),
      name: l.title ?? String(l.fields.name ?? ""),
      short_name: l.subtitle ?? (l.fields.short_name as string | null) ?? null,
    }));
    return extractLocation(`it in ${said}`, lite).locationId;
  } catch (err) {
    console.error("[core-scan] places could not be read for an agent's add:", (err as Error).message);
    return undefined;
  }
}

/** A typed thing into the inbox: the note door's whole shaping (a place
 *  phrase split off and resolved, a typed product code stamped as the row's
 *  barcode, the raw text kept as the description), shared with the
 *  assistant's door so an agent's add is shaped exactly as a person's note. */
async function admitTypedNote(
  req: Request,
  o: {
    text: string;
    door: "note" | "assistant";
    target_location_id?: string | null;
    scan_batch_id?: string | null;
    scan_area?: string | null;
    /** Stamped on suggested_metadata beside the description. */
    metadata?: Record<string, unknown>;
    /** Columns the door sets beyond the note's (a photo, a code, a count). */
    values?: Partial<InsertValues>;
    settle?: boolean;
  },
) {
  const db = tenantDb(req);
  const ctx = tenantContext(req);
  const session = sessionUser(req);

  // Freeform capture often names the place too ("Logic analyzer in cabinet
  // 002"). Split the location phrase off the item and resolve it against the
  // workspace's locations, so the item lands pre-filed instead of the whole
  // sentence becoming its name. Best-effort: any failure leaves the raw text
  // as the name (the matchmaker still routes it).
  let itemName = o.text;
  let locationId: string | null = o.target_location_id ?? null;
  let scanArea: string | null = o.scan_area ?? null;
  if (!o.target_location_id) {
    try {
      const locs = await platform().entities.list(ctx.org.id, "core-locations:location", {
        limit: 1000,
      });
      const lite: LocationLite[] = locs.items.map((l) => ({
        id: String(l.id),
        // name = the location's title role; short_name = its subtitle role.
        name: l.title ?? String(l.fields.name ?? ""),
        short_name: l.subtitle ?? (l.fields.short_name as string | null) ?? null,
      }));
      const ex = extractLocation(o.text, lite);
      itemName = ex.itemText || o.text;
      locationId = ex.locationId;
      // Keep an explicit scan_area override; otherwise stamp the unresolved
      // phrase so the location is still captured as a hint for confirm.
      if (!scanArea && !ex.locationId && ex.locationPhrase) scanArea = ex.locationPhrase;
    } catch (err) {
      console.error("[core-scan] note location extraction failed:", (err as Error).message);
    }
  }

  noteScanCaptured(ctx.org.id, session.id, "note");
  // What was typed decides the shape (services/intake.ts, #3049): a product
  // code takes the catalog chain like a scanned one, a model or part
  // number ("PB287Q") goes to the web before the match, and a phrase goes
  // straight to the matchmaker with a picture search after. The door
  // stamps a typed product code as the row's barcode so every reader of
  // the row (the tracked-match finder, the card) sees it as one.
  const typed = typedIdentifier(itemName);
  return intakeRow({
    db,
    orgId: ctx.org.id,
    orgSlug: ctx.org.slug,
    userId: session.id,
    token: bearer(req),
    baseUrl: (req.headers["x-cobblr-base-url"] as string | undefined) ?? INTERNAL_API,
    visitorIp: req.ip ?? null,
    door: o.door,
    settle: o.settle,
    values: {
      source_kind: "note",
      ...(typed?.kind === "code" && !/^https?:\/\//i.test(typed.code) ? { barcode_text: typed.code } : {}),
      ...(typed?.kind === "code" && /^https?:\/\//i.test(typed.code) ? { source_url: typed.code } : {}),
      // The cleaned item phrase is the provisional name; the FULL raw text
      // stays as the matchmaker's description so no extraction context is lost.
      suggested_name: itemName.slice(0, 300),
      suggested_metadata: JSON.stringify({ description: o.text, ...(o.metadata ?? {}) }) as never,
      scan_batch_id: o.scan_batch_id ?? null,
      scan_area: scanArea,
      target_location_id: locationId,
      created_by_user_id: session.id,
      ...(o.values ?? {}),
    },
  });
}

// AI-REACH: exempt — the scanner's intake of a note captured beside a scan;
// the assistant adds a thing through add_thing, the same intake by words
intakeRouter.post(
  "/scan/note",
  asyncHandler(async (req, res) => {
    if (!requireRole(req, res, "owner", "admin", "member")) return;
    const parsed = NoteBody.safeParse(req.body);
    if (!parsed.success) return badBody(res, parsed.error);
    const body = parsed.data;
    const admitted = await admitTypedNote(req, {
      text: body.text,
      door: "note",
      target_location_id: body.target_location_id,
      scan_batch_id: body.scan_batch_id,
      scan_area: body.scan_area,
    });
    // Served like every other row (#3017): the dashboard's card reads this
    // response first and shows the row's progress from it.
    res.status(201).json(await served(req, admitted.row as never));
  }),
);

// ─────────────────────────── POST /scan/assistant ────────────────────
// An AI agent adding a thing (#4472): the add_thing tool, over MCP and in the
// chat alike. A bare create made whatever fields the agent thought to send,
// and a second printer beside the one already there. This door puts the
// thing through the inbox's own intake instead, the note door's shaping and
// the same plan: identify, the duplicate check, kind and category routing,
// the table's fields filled, a picture, a place. It waits for that plan and
// answers with what it found, the record already tracked, and the table's
// fields still empty as hints the agent can ask its person about.
//
// Inbox first, always: the row is there with everything the intake found.
// The agent then files it in this call (`file: true`) through the same
// confirm a person's Add uses, or leaves it in the inbox, marked as from the
// assistant, for its person to look over. A thing you already have is never
// filed as a second one unless the agent says so.

const AssistantBody = z.object({
  /** What the thing is called, as the agent knows it ("Prusa MK4"). */
  name: z.string().trim().min(1).max(300),
  /** A barcode, ISBN, model or part number. A product code is stamped as
   *  the row's code, as a typed one is; anything else is kept as a note. */
  identifier: optionalField(z.string().trim().min(1).max(200)),
  /** A page about it, for the agent that found one. */
  url: optionalField(z.string().url().max(2000)),
  /** A photo uploaded first through core-files. */
  image_file_id: optionalUuid(),
  /** Where it is, in words ("in the garage") or as a place's id. */
  place: optionalField(z.string().trim().min(1).max(200)),
  location_id: optionalUuid(),
  /** Field values the agent already knows, by the table's field names (or
   *  their labels). Placed on the table the thing is routed to; each one is
   *  reported back as kept or refused with the reason (#4537). */
  fields: z.record(z.union([z.string(), z.number(), z.boolean()])).optional(),
  /** Values by what they ARE rather than what a workspace calls them: where
   *  it was bought, who sold it, when, for how much (arrivals.md §2). */
  roles: z.record(z.union([z.string(), z.number(), z.boolean()])).optional(),
  /** The list it belongs in, said by the person ("3D Printers", or a kind id
   *  like 3d-printers:item): their answer, so routing honours it. */
  goes_to: optionalField(z.string().trim().min(1).max(200)),
  quantity: z.number().positive().max(1_000_000).optional(), // none-refused-ok: a column that cannot hold null
  /** File it now. Absent or false: it stays in the inbox for its person. */
  file: z.boolean().optional(),
  /** File it even though the workspace already tracks the same thing. */
  allow_duplicate: z.boolean().optional(),
});

// AI-TOOL: add_thing
// UI-REACH: an agent's door; a person adds the same way through the scanner's note, code and camera doors
intakeRouter.post(
  "/scan/assistant",
  asyncHandler(async (req, res) => {
    if (!requireRole(req, res, "owner", "admin", "member")) return;
    const parsed = AssistantBody.safeParse(req.body);
    if (!parsed.success) return badBody(res, parsed.error);
    const token = bearer(req);
    if (!token) {
      res.status(401).json({ error: { code: "no_auth", message: "Bearer token required" } });
      return;
    }
    res.status(201).json(await addThingFor(req, token, parsed.data));
  }),
);

/** One thing an agent adds, through the inbox's own intake: the add_thing
 *  door, and each piece of add_things_from_photo (`extra` carries what a
 *  piece knows of its group photo). */
async function addThingFor(req: Request, token: string, body: z.infer<typeof AssistantBody>, extra: { metadata?: Record<string, unknown> } = {}) {
    const ctx = tenantContext(req);
    const db = tenantDb(req);
    const baseUrl = (req.headers["x-cobblr-base-url"] as string | undefined) ?? INTERNAL_API;
    const authHeaders = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };

    // A product code is the row's code (the catalog chain reads it); any
    // other identifier stays with the description for the match to read.
    const code = body.identifier ? typedIdentifier(body.identifier) : null;
    const asCode = code?.kind === "code" ? code.code : null;
    // "MakerGear M2 (from RainMotorSports)": the thing, and who it came from.
    // The name stays the thing's, so the same thing is found and routed the
    // same way; the person goes to the seller, where the card shows them.
    const said = sellerInName(body.name);
    if (said) {
      body.name = said.name;
      if (!body.roles?.seller) body.roles = { ...(body.roles ?? {}), seller: said.seller };
    }
    // "Bambu Lab P1P #36 (for parts, power issue)": the thing is a Bambu Lab
    // P1P, matched and routed as one, and the caller's whole name is kept as
    // theirs for the card, so two units still read apart (#4591).
    const callersName = body.name;
    const thing = thingInName(body.name);
    if (thing) body.name = thing;
    // The values it came with are evidence about which list it belongs in,
    // so they ride in BEFORE the match: a field only one list has (a 3D
    // printer's bed size) routes it there instead of being refused by a list
    // the model guessed (#4591, kept-route.ts routeByGivenFields), and the
    // maker it names is read by the same-maker rule. When no list keeps them
    // all, they are placed after the route, as before.
    const menu = await assembleScanMenu(baseUrl, ctx.org.slug, token, ctx.org.id).catch(() => [] as ScanMenuEntry[]);
    // A category that names an installed list says where the thing goes: a
    // book said to be "Books" goes to the Bookshelf, as a scanned book does.
    // Read as a field it routed by the field's NAME, to whichever table has
    // a "category" (Records), and never by what it named (#6037). The value
    // is the list's name, and inside that list it says nothing more.
    if (!body.goes_to && body.fields) {
      const axes = new Set(["category", ...menu.map((e) => e.category_field?.name ?? "")].filter(Boolean).map((n) => n.toLowerCase()));
      const key = Object.keys(body.fields).find((k) => axes.has(k.toLowerCase()));
      const named = key ? listNamedByCategory(body.fields[key], menu) : null;
      if (key && named) {
        body.goes_to = named.label;
        delete body.fields[key];
      }
    }
    const early = (body.fields && Object.keys(body.fields).length) ? await givenValuesTable(ctx.org.id, menu, body.fields, body.roles) : null;
    // A place the agent named is a place, never part of the name. It used to
    // ride in the text ("Cordless drill in Garage") for the note door to split
    // off, and where no Garage existed yet the split failed: the record was
    // called "Cordless drill in Garage" and the place was lost without a word
    // (the assistant audit on staging, #6686). Resolved here; a place that is
    // not one of the workspace's stays the said place and is reported.
    let locationId = body.location_id ?? null;
    let placeNotFound: string | null = null;
    let placeUnread = false;
    if (body.place && !locationId) {
      const found = await placeNamed(ctx.org.id, body.place);
      if (found === undefined) placeUnread = true;
      else if (found === null) placeNotFound = body.place;
      else locationId = found;
    }
    const admitted = await admitTypedNote(req, {
      text: body.name,
      door: "assistant",
      target_location_id: locationId,
      ...(placeNotFound || placeUnread ? { scan_area: body.place } : {}),
      metadata: {
        arrived_by: "assistant",
        ...(extra.metadata ?? {}),
        ...(body.identifier && !asCode ? { identifier: body.identifier } : {}),
        ...(early
          ? {
              user_fields: { kind: early.kind, values: early.values },
              [FIELD_PROVENANCE_KEY]: Object.fromEntries(Object.keys(early.values).map((k) => [k, { by: "person", from: "assistant", at: new Date().toISOString() }])),
            }
          : {}),
      },
      values: {
        ...(asCode && !/^https?:\/\//i.test(asCode) ? { barcode_text: asCode } : {}),
        ...(body.url ? { source_url: body.url } : {}),
        ...(body.image_file_id ? { image_file_id: body.image_file_id } : {}),
        ...(body.quantity != null ? { quantity: body.quantity } : {}),
      },
      settle: true,
    });
    const itemId = admitted.row.id;
    if (thing) {
      await db.transaction().execute(async (tx) => {
        const cur = await tx.selectFrom("core_scan_inbox_items").select(["suggested_metadata"]).where("id", "=", itemId).forUpdate().executeTakeFirst();
        const meta = applyPersonName((cur?.suggested_metadata ?? {}) as Record<string, unknown>, callersName);
        const keys = Object.keys(meta).filter((k) => JSON.stringify(meta[k]) !== JSON.stringify(((cur?.suggested_metadata ?? {}) as Record<string, unknown>)[k]));
        if (keys.length) {
          await tx
            .updateTable("core_scan_inbox_items")
            .set({ suggested_metadata: mergeMeta(Object.fromEntries(keys.map((k) => [k, meta[k]]))) as never, updated_at: new Date() })
            .where("id", "=", itemId)
            .execute();
        }
      });
    }

    // The list it goes to, when the person (through their agent) said it:
    // their answer, stored as a person's choice, so every door files there.
    let goesToRefused: string | null = null;
    if (body.goes_to) {
      const said = body.goes_to.toLowerCase();
      const entry = menu.find((e) => e.kind.toLowerCase() === said || (e.instance ?? "").toLowerCase() === said || e.label.toLowerCase() === said || e.noun.toLowerCase() === said);
      if (!entry) goesToRefused = `no list called ${body.goes_to}; the lists are ${menu.map((e) => e.label).join(", ")}`;
      else {
        const stored: StoredDestination = { module: entry.module, instance: entry.instance ?? null, kind: entry.kind, label: entry.label, by: "person", at: new Date().toISOString() };
        await db
          .updateTable("core_scan_inbox_items")
          .set({ suggested_metadata: mergeMeta({ [DESTINATION_KEY]: stored }) as never, updated_at: new Date() })
          .where("id", "=", itemId)
          .execute();
      }
    }

    // What the agent already knows rides as the person's own values do
    // (services/user-fields.ts), placed on the table the thing was ROUTED to:
    // the values follow the route and never pick it (#4591). Each one is kept
    // or refused with the reason, never dropped into a log (agent-fields.ts,
    // #4537). Who it came from rides beside where (seller-split.ts, #4593).
    let placed: ReturnType<typeof placeAgentFields> | null = null;
    if ((body.fields && Object.keys(body.fields).length) || (body.roles && Object.keys(body.roles).length)) {
      const now = await db.selectFrom("core_scan_inbox_items").selectAll().where("id", "=", itemId).executeTakeFirstOrThrow();
      const dest = filingDestination(now as never, destinationTables(menu), await liveTablesFor(req));
      const entry = dest ? menu.find((e) => e.module === dest.module && (e.instance ?? null) === (dest.instance ?? null)) : undefined;
      const kind = entry?.kind ?? dest?.kind ?? null;
      const table = { label: entry?.label ?? dest?.label ?? "this list", fields: kind ? await agentFieldsFor(ctx.org.id, kind, entry?.fields ?? []) : (entry?.fields ?? []) };
      placed = placeAgentFields(body.fields, body.roles, table);
      const roles = new Map<string, string>();
      for (const f of table.fields) if (f.field_role) roles.set(f.name, f.field_role);
      const values = withSellersApart(placed.values, body.name, roles);
      if (Object.keys(values).length) {
        await db.transaction().execute(async (tx) => {
          const cur = await tx.selectFrom("core_scan_inbox_items").select(["suggested_metadata"]).where("id", "=", itemId).forUpdate().executeTakeFirst();
          const meta = applyUserFieldPatch((cur?.suggested_metadata ?? {}) as Record<string, unknown>, values, entry?.kind ?? dest?.kind ?? null);
          const at = new Date().toISOString();
          const stamps: FieldProvenanceMap = { ...fieldProvenanceOf(meta) };
          for (const name of Object.keys(values)) stamps[name] = { by: "person", from: "assistant", at };
          // Only the two keys this sets, merged onto the live row.
          await tx
            .updateTable("core_scan_inbox_items")
            .set({ suggested_metadata: mergeMeta({ user_fields: meta.user_fields, [FIELD_PROVENANCE_KEY]: stamps }) as never, updated_at: new Date() })
            .where("id", "=", itemId)
            .execute();
        });
      }
    }

    const fresh = await db.selectFrom("core_scan_inbox_items").selectAll().where("id", "=", itemId).executeTakeFirstOrThrow();
    const row = await served(req, fresh as never);
    const tables = await destinationTablesFor(req);
    const found = whatTheIntakeFound(row as never, tables, admitted.inline === "timeout");

    let filed: { entity_id: string | null; entity_kind: string | null } | null = null;
    let notFiled: string | null = null;
    if (body.file) {
      if (found.already_have && !body.allow_duplicate) {
        notFiled = `already tracked as "${found.already_have.title}"; left in the inbox`;
      } else {
        const canInstall = roleSatisfies((req as unknown as { tenant?: { role: string } }).tenant?.role as "owner", ["owner", "admin"]);
        const door = { baseUrl, slug: ctx.org.slug, authHeaders, canInstall, tables };
        const outcome = await fileThroughConfirm(door, new BundleInstaller(door), withPersonName(fresh as never) as never, locationId);
        if (outcome.ok) filed = { entity_id: outcome.entity_id, entity_kind: outcome.entity_kind };
        else notFiled = outcome.reason;
      }
    }

    const kept = placed ? { fields_kept: placed.kept, fields_refused: placed.refused } : { fields_kept: [], fields_refused: [] };
    return {
      ...found,
      // What the agent said it had, echoed so it can say it back ("200 M3 screws").
      quantity: (fresh as { quantity?: number | null }).quantity ?? null,
      ...kept,
      ...(goesToRefused ? { goes_to_refused: goesToRefused } : {}),
      ...(placeNotFound ? { place_not_found: `no place called "${placeNotFound}" here; it is kept as the place they said. Ask whether to make it (create_record core-locations:location), or name a place that exists.` } : {}),
      filed,
      not_filed_because: notFiled,
      next: nextForTheAgent(found, filed, notFiled, !!body.file, kept.fields_refused, goesToRefused),
    };
}

// ──────────────────── POST /scan/assistant/photo ─────────────────────
// Several things from one photo (#6342): "this photo is printer 1 {details}
// and printer 2 {details}". The caller lists the pieces; Cobblr works out
// where each sits (its own box, or the split's detection told the list),
// crops each, and adds each through add_thing's own intake with its crop as
// its picture. The photo becomes the group shot, the pieces one split group
// ("2 of 2") with Undo split. A photo that shows a different number than was
// listed is asked about and nothing is added.
const PhotoPieceBox = z.object({ x: z.number().min(0).max(1), y: z.number().min(0).max(1), w: z.number().gt(0).max(1), h: z.number().gt(0).max(1) });
const PhotoPiece = AssistantBody.omit({ image_file_id: true, file: true, allow_duplicate: true }).extend({
  /** Where it sits in the photo, in words: "left", "the black one". */
  where: optionalField(z.string().trim().min(1).max(200)),
  /** Where it sits, as fractions of the picture (x, y top-left; w, h). */
  box: PhotoPieceBox.optional(),
});
const PhotosOfSeveralBody = z
  .object({
    /** The photo, uploaded first through core-files. */
    image_file_id: optionalUuid(),
    /** Or a photo already in the inbox, split by this list. */
    item_id: optionalUuid(),
    items: z.array(PhotoPiece).min(2).max(20),
  })
  .refine((b) => !!b.image_file_id !== !!b.item_id, { message: "give the photo as image_file_id, or the inbox item as item_id, one of them" });

// AI-ACTION: core-scan:add-things-from-photo
intakeRouter.post(
  "/scan/assistant/photo",
  asyncHandler(async (req, res) => {
    if (!(await requireCapability(req, res, "core-scan:add-things-from-photo"))) return;
    const parsed = PhotosOfSeveralBody.safeParse(req.body);
    if (!parsed.success) return badBody(res, parsed.error);
    const token = bearer(req);
    if (!token) {
      res.status(401).json({ error: { code: "no_auth", message: "Bearer token required" } });
      return;
    }
    const body = parsed.data;
    const ctx = tenantContext(req);
    const db = tenantDb(req);
    const userId = sessionUser(req).id;

    let existing: { id: string; image_file_id: string | null; status: string; ai_notes: string | null; suggested_metadata: unknown } | undefined;
    if (body.item_id) {
      existing = await db.selectFrom("core_scan_inbox_items").select(["id", "image_file_id", "status", "ai_notes", "suggested_metadata"]).where("id", "=", body.item_id).executeTakeFirst();
      if (!existing) return void res.status(404).json({ error: { code: "not_found", message: "inbox item not found" } });
      if (!existing.image_file_id) return void res.status(409).json({ error: { code: "no_photo", message: "That inbox item has no photo to split." } });
      if (existing.status !== "pending" || (existing.suggested_metadata as { split_into?: unknown } | null)?.split_into) {
        return void res.status(409).json({ error: { code: "not_splittable", message: "That inbox item is already filed or split." } });
      }
    }
    const photo = existing?.image_file_id ?? body.image_file_id!;

    // Where each piece sits, before anything is written: a disagreement is a
    // question, and asking must leave nothing behind.
    const listed: ListedPiece[] = body.items.map((it) => ({ name: it.name, where: it.where ?? null, box: it.box ?? null }));
    const detected = allBoxed(listed) ? { items: [], failed: false } : await detectSplitItems(ctx.org.id, photo, userId, listed);
    const placed = placeListed(listed, detected.items, detected.failed);
    if (!placed.ok) {
      return void res.status(409).json({
        error: { code: "count_mismatch", message: countMismatchSentence(listed, placed.seen) },
        seen: placed.seen,
        listed: listed.map((l) => l.name),
      });
    }

    const parent = existing ?? (
      await intakeRow({
        db,
        orgId: ctx.org.id,
        orgSlug: ctx.org.slug,
        userId,
        token,
        baseUrl: (req.headers["x-cobblr-base-url"] as string | undefined) ?? INTERNAL_API,
        visitorIp: req.ip ?? null,
        door: "assistant",
        values: {
          source_kind: "photo",
          image_file_id: photo,
          suggested_name: `${countOf(listed.length, "thing")} from one photo`,
          created_by_user_id: userId,
          // The group shot is only the pieces' photo: nothing to identify.
          suggested_metadata: JSON.stringify({ arrived_by: "assistant", intake_shape: "import" }) as never,
        },
      })
    ).row;

    const pieces: Array<Record<string, unknown>> = [];
    const ids: string[] = [];
    for (const [n, it] of body.items.entries()) {
      const at = placed.pieces[n]!;
      const cut = at.box ? await cropRegion(ctx.org.id, photo, at.box) : null;
      const crop = cut?.fileId ? "ok" : at.box ? "failed" : "none";
      const { where: _where, box: _box, ...thing } = it;
      const added = await addThingFor(req, token, { ...thing, image_file_id: cut?.fileId ?? photo }, {
        metadata: {
          source: "vision-split",
          split_from: parent.id,
          split_region: at.box,
          crop,
          ...(cut && "reason" in cut ? { crop_reason: cut.reason } : {}),
          ...(at.boxed_as && at.boxed_as !== it.name ? { split_boxed_as: at.boxed_as } : {}),
        },
      });
      ids.push(added.item_id);
      pieces.push({
        item_id: added.item_id,
        name: added.name,
        crop_file_id: cut?.fileId ?? null,
        crop,
        ...(cut && "reason" in cut ? { crop_refused: cropRefusalWords(cut.reason) } : {}),
        goes_to: added.goes_to,
        already_have: added.already_have,
        fields_kept: added.fields_kept,
        fields_refused: added.fields_refused,
        ...(added.goes_to_refused ? { goes_to_refused: added.goes_to_refused } : {}),
      });
    }
    await db
      .updateTable("core_scan_inbox_items")
      .set({
        status: "resolved",
        suggested_metadata: mergeMeta({ split_into: ids, split_prior_notes: existing?.ai_notes ?? null, split_how: "photo" }) as never,
        ai_notes: `Split into ${countOf(ids.length, "item")}.`,
        resolved_at: new Date(),
        updated_at: new Date(),
      })
      .where("id", "=", parent.id)
      .execute();
    await appendScanHistory(db, parent.id, { action: "split", note: `${countOf(ids.length, "item")} listed by the assistant; crops: ${pieces.map((p) => p.crop).join(", ")}` });
    const group = (await splitParentsOf(db, [{ id: ids[0]!, suggested_metadata: { split_from: parent.id } }])).summaries[parent.id] ?? null;
    res.status(201).json({
      group: { item_id: parent.id, headline: group?.headline ?? null, check: group?.check ?? null, can_undo: group?.can_undo ?? true },
      items: pieces,
      ...(placed.uncut ? { uncut: "The photo could not be read for where each piece sits, so each keeps the whole photo; crop one from its card." } : {}),
      next: `${countOf(ids.length, "thing")} from one photo are in the inbox as one group. Undo split (core-scan:undo-split with item_id ${parent.id}) puts them back as one photo.`,
    });
  }),
);

/** Where an agent's values are stamped before the match, placed on that
 *  list: the list they name on their own (the only one that keeps them all,
 *  or the module's catch-all when only one module's lists do), else the
 *  first that keeps them all. The match then routes by its own rules
 *  (kept-route.ts) and the values follow. Null when no list keeps them all. */
async function givenValuesTable(
  orgId: string,
  menu: readonly ScanMenuEntry[],
  fields: Record<string, string | number | boolean>,
  roles: Record<string, string | number | boolean> | undefined,
): Promise<{ kind: string; values: Record<string, unknown> } | null> {
  const placed = await Promise.all(
    menu.map(async (e) => ({ e, p: placeAgentFields(fields, roles, { label: e.label, fields: await agentFieldsFor(orgId, e.kind, e.fields) }) })),
  );
  const fitting = placed.filter(({ p }) => p.refused.length === 0 && Object.keys(p.values).length > 0);
  if (!fitting.length) return null;
  const modules = new Set(fitting.map(({ e }) => e.module));
  // Stamped on the list they name when they name one; else on the first that
  // keeps them all, so the match still reads them (the maker the same-maker
  // rule needs, #4591) and moves them with the route it settles on.
  const pick = (fitting.length === 1 ? fitting[0] : modules.size === 1 ? fitting.find(({ e }) => !e.instance) : undefined) ?? fitting[0]!;
  return { kind: pick.e.kind, values: pick.p.values };
}

/** What the intake found on one row, for the agent that asked: the record
 *  already tracked, where it goes, the fields filled, the picture, the place,
 *  and the table's fields still empty. Read from the served row, the one the
 *  card reads, so the agent hears what a person would see. */
function whatTheIntakeFound(
  row: Record<string, unknown>,
  tables: readonly ScanResolverTable[],
  stillIdentifying: boolean,
) {
  const meta = (row.suggested_metadata ?? {}) as Record<string, unknown>;
  const stamp = (meta.tracked_match ?? null) as TrackedMatchStamp | null;
  const cands = Array.isArray(row.suggested_candidates) ? (row.suggested_candidates as Array<Record<string, unknown>>) : [];
  const top = cands[0] ?? null;
  const dest = (row.resolved_destination ?? null) as { module: string; instance: string | null; kind: string | null; label: string | null } | null;
  const fields = (top?.fields ?? {}) as Record<string, unknown>;
  const table = dest
    ? tables.find((t) => (t as { module_name?: string }).module_name === dest.module && ((t as { instance?: string | null }).instance ?? null) === (dest.instance ?? null))
    : undefined;
  const filled = (v: unknown) => v != null && !(typeof v === "string" && !v.trim());
  const hints = ((table?.fields ?? []) as Array<{ name: string; label: string }>)
    .filter((f) => !filled(fields[f.name]))
    .map((f) => ({ name: f.name, label: f.label }));
  return {
    item_id: String(row.id),
    name: (row.suggested_name as string | null) ?? null,
    from: "assistant" as const,
    already_have: stamp
      ? { kind: stamp.kind, id: stamp.id, title: stamp.title, instance: stamp.instance, matched_by: stamp.matched_by, of: stamp.of }
      : null,
    goes_to: dest ? { module: dest.module, instance: dest.instance, kind: dest.kind, label: dest.label } : null,
    category: (top?.category as string | null | undefined) ?? null,
    fields,
    picture: (row.image_file_id as string | null) ?? (row.catalog_image_file_id as string | null) ?? (row.catalog_image_url as string | null) ?? null,
    place: { location_id: (row.target_location_id as string | null) ?? null, said: (row.scan_area as string | null) ?? null },
    hints,
    still_identifying: stillIdentifying,
    needs_review: !!row.needs_review,
    review_reason: (row.review_reason as string | null | undefined) ?? null,
  };
}

/** One sentence the agent can act on. */
function nextForTheAgent(
  found: ReturnType<typeof whatTheIntakeFound>,
  filed: { entity_id: string | null } | null,
  notFiled: string | null,
  askedToFile: boolean,
  refused: ReadonlyArray<{ name: string; reason: string }> = [],
  goesToRefused: string | null = null,
): string {
  // What was not kept comes first: the agent must not tell its person a
  // value was saved that was not.
  const notKept = [...refused.map((r) => `${r.name}: ${r.reason}`), ...(goesToRefused ? [goesToRefused] : [])];
  const lead = notKept.length ? `Not kept: ${notKept.join("; ")}. ` : "";
  return lead + nextSentence(found, filed, notFiled, askedToFile);
}

function nextSentence(
  found: ReturnType<typeof whatTheIntakeFound>,
  filed: { entity_id: string | null } | null,
  notFiled: string | null,
  askedToFile: boolean,
): string {
  if (filed) return found.hints.length ? `Filed. Still empty: ${found.hints.map((h) => h.label).join(", ")}. Ask your person, then update the record.` : "Filed.";
  if (found.already_have && !filed) return `Already tracked as "${found.already_have.title}". Tell your person; add to it instead, or file again with allow_duplicate if it really is a second one.`;
  if (askedToFile && notFiled) return `Not filed: ${notFiled}. It is in the inbox for your person.`;
  if (found.still_identifying) return "In the inbox; the photo is still being identified. Read it again with get_scan_item.";
  return found.hints.length
    ? `In the inbox for your person. Still empty: ${found.hints.map((h) => h.label).join(", ")}. Ask, then file it with add_thing's file option or let them file it.`
    : "In the inbox for your person, ready to file.";
}

// A line on a purchase that a reader kept off the inbox (a bill of sale's
// add-on, like wheel locks) becomes an inbox item when a person says so, in
// the session its receipt made, linked to its order line so filing claims it
// (#4523). Charges are never offered this; the purchase page only shows the
// button on an add-on.
const OrderLineToInbox = z.object({
  order_id: z.string().uuid(),
  order_item_id: z.string().uuid(),
  description: z.string().trim().min(1).max(300),
  qty: z.number().positive().max(100000).default(1),
  unit_cost: z.number().nonnegative().nullable().optional(),
});
// AI-REACH: exempt — the purchase page's button for one add-on line; the assistant puts a thing in the inbox through its own add door
intakeRouter.post(
  "/inbox/from-order-line",
  asyncHandler(async (req, res) => {
    if (!requireRole(req, res, "owner", "admin", "member")) return;
    const parsed = OrderLineToInbox.safeParse(req.body);
    if (!parsed.success) return badBody(res, parsed.error);
    const db = tenantDb(req);
    const ctx = tenantContext(req);
    const session = sessionUser(req);
    const b = parsed.data;
    // Once: a second press finds the row the first one made.
    const existing = await db
      .selectFrom("core_scan_inbox_items")
      .select("id")
      .where(sql<boolean>`suggested_metadata->>'receipt_order_item_id' = ${b.order_item_id}`)
      .executeTakeFirst();
    if (existing) {
      res.json({ id: existing.id, existed: true });
      return;
    }
    // The session the receipt made, read off a row its purchase already stamped.
    const sibling = await db
      .selectFrom("core_scan_inbox_items")
      .select(["scan_batch_id", "suggested_metadata"])
      .where(sql<boolean>`suggested_metadata->>'receipt_order_id' = ${b.order_id}`)
      .executeTakeFirst();
    const siblingMeta = (sibling?.suggested_metadata ?? {}) as Record<string, unknown>;
    const lineTotal = b.unit_cost != null ? amountOf(centsFromAmount(b.unit_cost * b.qty)) : null;
    const admitted = await intakeRow({
      db,
      orgId: ctx.org.id,
      orgSlug: ctx.org.slug,
      userId: session.id,
      token: bearer(req),
      baseUrl: (req.headers["x-cobblr-base-url"] as string | undefined) ?? INTERNAL_API,
      door: "receipt",
      values: {
        source_kind: "receipt",
        scan_batch_id: sibling?.scan_batch_id ?? null,
        suggested_name: b.description,
        quantity: b.qty,
        suggested_metadata: JSON.stringify({
          source: "receipt",
          description: b.description,
          unit_price: b.unit_cost ?? null,
          line_total: lineTotal,
          receipt_line_count: 1,
          receipt_order_id: b.order_id,
          receipt_order_item_id: b.order_item_id,
          ...(siblingMeta.receipt_group_id ? { receipt_group_id: siblingMeta.receipt_group_id } : {}),
          ...(siblingMeta.receipt_date ? { receipt_date: siblingMeta.receipt_date } : {}),
          ...(siblingMeta.receipt_vendor ? { receipt_vendor: siblingMeta.receipt_vendor } : {}),
          ...(siblingMeta.receipt_seller ? { receipt_seller: siblingMeta.receipt_seller } : {}),
          ...(siblingMeta.receipt_currency ? { receipt_currency: siblingMeta.receipt_currency } : {}),
        }) as never,
        created_by_user_id: session.id,
      },
    });
    res.status(201).json({ id: admitted.row.id, existed: false });
  }),
);

// Which of one purchase's lines are already inbox items, so its page shows
// "In the scan inbox" rather than offering the same line twice after a reload.
intakeRouter.get(
  "/inbox/order-lines",
  asyncHandler(async (req, res) => {
    if (!requireRole(req, res, "owner", "admin", "member", "guest")) return;
    const orderId = typeof req.query.order_id === "string" ? req.query.order_id : "";
    if (!/^[0-9a-f-]{36}$/i.test(orderId)) {
      res.status(400).json({ error: { code: "bad_request", message: "order_id is required" } });
      return;
    }
    const rows = await tenantDb(req)
      .selectFrom("core_scan_inbox_items")
      .select(["id", sql<string>`suggested_metadata->>'receipt_order_item_id'`.as("order_item_id")])
      .where(sql<boolean>`suggested_metadata->>'receipt_order_id' = ${orderId}`)
      .execute();
    res.json({ items: rows.filter((r) => r.order_item_id).map((r) => ({ order_item_id: r.order_item_id, id: r.id })) });
  }),
);
const PaperworkBody = RecordRef.extend({ file_id: z.string().uuid() });
const FillBody = z.object({ field: z.string().min(1).max(120), label: z.string().max(200).default(""), native: z.boolean(), value: z.union([z.string(), z.number()]), shown: z.string().max(200).default("") });

// AI-ACTION: core-scan:attach-paperwork
intakeRouter.post(
  "/scan/paperwork",
  asyncHandler(async (req, res) => {
    if (!(await requireCapability(req, res, "core-scan:attach-paperwork"))) return;
    const parsed = PaperworkBody.safeParse(req.body);
    if (!parsed.success) return badBody(res, parsed.error);
    const ctx = tenantContext(req);
    const session = sessionUser(req);
    const http = paperworkHttp(req, ctx.org.slug);
    const result = await attachPaperwork({
      orgId: ctx.org.id,
      userId: session.id,
      fileId: parsed.data.file_id,
      kind: parsed.data.kind,
      id: parsed.data.id,
      http,
    });
    res.json(result);
  }),
);

// AI-REACH: exempt — the toast's Undo for one fill; the assistant takes a fill back with the record's own update
intakeRouter.post(
  "/scan/paperwork/undo",
  asyncHandler(async (req, res) => {
    if (!requireRole(req, res, "owner", "admin", "member")) return;
    const parsed = RecordRef.extend({ fills: z.array(FillBody).max(50) }).safeParse(req.body);
    if (!parsed.success) return badBody(res, parsed.error);
    const ctx = tenantContext(req);
    const undone = await undoPaperworkFill(ctx.org.id, parsed.data.kind, parsed.data.id, parsed.data.fills);
    res.json({ undone });
  }),
);

// AI-REACH: exempt — "Use it" on one disagreement; the assistant sets a field through the record's own update
intakeRouter.post(
  "/scan/paperwork/take",
  asyncHandler(async (req, res) => {
    if (!requireRole(req, res, "owner", "admin", "member")) return;
    const parsed = RecordRef.extend({ field: z.string().min(1).max(120), native: z.boolean(), value: z.union([z.string(), z.number()]) }).safeParse(req.body);
    if (!parsed.success) return badBody(res, parsed.error);
    const ctx = tenantContext(req);
    const ok = await takePaperworkValue(ctx.org.id, parsed.data.kind, parsed.data.id, parsed.data);
    if (!ok) {
      res.status(409).json({ error: { code: "not_written", message: "That field could not be written on this record." } });
      return;
    }
    res.json({ ok: true });
  }),
);
