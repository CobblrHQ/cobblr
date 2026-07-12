// /api/v1/orgs/:slug/modules/core-scan
//
// v0.1 routes:
//   POST /scan                  — ingest a barcode (photos = v0.2).
//                                  Inline-enriches up to a 12s budget.
//   POST /scan/note              — capture free text → matchmaker.
//   POST /scan/receipt          — parse a receipt PDF/photo (core-ai) into
//                                  one inbox row per line item.
//   GET  /inbox                  — list pending+resolved items.
//   GET  /inbox/:id              — one item.
//   POST /inbox/:id/confirm      — commit into target_module/kind.
//   POST /inbox/:id/discard      — soft-delete from queue.
//   POST /inbox/:id/rerun-ai     — re-run barcode enrichment.
//   POST /batches                — mint a scan batch.
//
// The /scan body is JSON for v0.1 (barcode-only). Photo upload
// goes via /scan-photo (v0.2) once the image_file_id can be
// obtained from a separate multipart endpoint — keeps the JSON
// body limits sane.

import { randomUUID } from "node:crypto";
import { Router } from "express";
import { sql } from "kysely";
import { z } from "zod";
import { platform } from "@cobblr/platform-contract";
import { bearer, sessionUser, tenantContext, tenantDb } from "../db.js";
import { asyncHandler, badBody, requireRole } from "./util.js";
import { downloadCatalogImage, enrichBarcodeItem, isJunkName } from "../services/enrich.js";
import {
  crossCheckScanPhoto,
  enrichPhotoItem,
  extractSerial,
  observeScanPhoto,
  refreshCatalogImageByName,
} from "../services/enrich-photo.js";
import { searchImages, rankImageOptions, imageQuery, mediaSearchExtras } from "../services/ddg-images.js";
import {
  assembleScanMenu,
  assembleMergedMenu,
  runMatchmaker,
  reconcileSeriesSecondaries,
  type MatchCandidate,
  type ScanMenuEntry,
} from "../services/matchmaker.js";
import { lookupBookIsbn } from "../services/book-lookup.js";
import { parseReceipt } from "../services/receipt.js";
import { reportBarcodeCorrection } from "../services/barcode-corrections.js";
import { findBinContents, findTracked } from "../services/entity-match.js";
import { cropRegion, detectSplitItems, rotateImage } from "../services/image-ops.js";
import { extractLocation, type LocationLite } from "../services/note-location.js";
import { suggestLocationForItem } from "../services/suggest-location.js";

export const inboxRouter = Router({ mergeParams: true });

// Internal self-call base for the create/enrich loopbacks below. These calls
// re-issue through our OWN api (to inherit requireAuth + withTenant + role
// gating) carrying the user's bearer token — so the base MUST be loopback to
// this process, never a caller-influenced value. `req.headers.host` is the
// BROWSER's origin (nginx forwards `Host: $host`); fetching it from inside the
// api container is unreachable (ECONNREFUSED → confirm 500) and would leak the
// token to whatever host the caller named. Mirrors services/enrich.ts. The
// `x-cobblr-base-url` override stays for isolated-stack e2e (home-life maps
// :4055→:4000); it's an explicit opt-in, not the default.
const INTERNAL_API = `http://127.0.0.1:${process.env.API_PORT ?? 4000}`;

// ─────────────────────────── GET /inbox/stats ──────────────────────
// Cheap counts for the put-away front door (dashboard card + scan-page
// strip): how many pending captures exist, and how many of those still have
// no home (no target location/container). One SQL, no rows.

inboxRouter.get(
  "/inbox/stats",
  asyncHandler(async (req, res) => {
    if (!requireRole(req, res, "owner", "admin", "member", "guest")) return;
    const db = tenantDb(req);
    const row = await db
      .selectFrom("core_scan_inbox_items")
      .select((eb) => [
        eb.fn.countAll<number>().as("pending"),
        eb.fn
          .count<number>(
            sql`case when target_location_id is null and target_container_id is null then 1 end`,
          )
          .as("unfiled"),
        // READY: already has a home (target_location_id set), still uncommitted
        // — the "all set, just put them away" count.
        eb.fn
          .count<number>(sql`case when target_location_id is not null then 1 end`)
          .as("ready"),
      ])
      .where("status", "=", "pending")
      .executeTakeFirstOrThrow();
    res.json({
      pending: Number(row.pending),
      unfiled: Number(row.unfiled),
      ready: Number(row.ready),
    });
  }),
);

// ─────────────────────────── POST /scan ────────────────────────────

const ScanBody = z.object({
  barcode: z.string().min(4).max(64).optional(),
  source_kind: z.enum(["barcode", "photo", "url", "receipt"]).default("barcode"),
  source_url: z.string().url().max(2000).optional(),
  image_file_id: z.string().uuid().optional(),
  scan_batch_id: z.string().uuid().optional(),
  scan_area: z.string().max(200).optional(),
  /** The active filing location ("bin") for this scan session — a
   *  core-locations node. Stamped on the item so confirm files the created
   *  entity into that location without re-picking. The active-bin pattern. */
  target_location_id: z.string().uuid().optional(),
  /** Scan-into-container: the active bin is a container ENTITY (a server asset,
   *  a machine) rather than a location. Confirm places the created item inside
   *  it (a placement) instead of stamping location_id. */
  target_container_kind: z.string().max(120).optional(),
  target_container_id: z.string().max(200).optional(),
  /** Per-scan budget for the inline enrichment race. After this
   *  the response returns the bare row and enrichment continues
   *  detached. Default 12s. */
  enrich_ms: z.number().int().positive().max(30_000).optional(),
});

inboxRouter.post(
  "/scan",
  asyncHandler(async (req, res) => {
    if (!requireRole(req, res, "owner", "admin", "member")) return;
    const parsed = ScanBody.safeParse(req.body);
    if (!parsed.success) return badBody(res, parsed.error);
    const body = parsed.data;

    // Require either a barcode or an image_file_id. A barcode takes the
    // fast path (catalog lookup → web-search fallback); a photo with no
    // barcode takes the vision path (core-ai identify-image), fired
    // detached below so intake stays instant.
    if (!body.barcode && !body.image_file_id) {
      res.status(400).json({
        error: {
          code: "no_input",
          message: "scan needs at least a barcode or an image_file_id",
        },
      });
      return;
    }

    const db = tenantDb(req);
    const ctx = tenantContext(req);
    const session = sessionUser(req);

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

    // Dedup repeated scans of the SAME barcode: rather than
    // pile up a new row per scan, bump the quantity on the pending entry that's
    // already there. Dedup is GLOBAL across all pending items for that barcode —
    // NOT scoped to a batch/area (batch-scoping let the same UPC pile up a fresh
    // row per session, which is exactly how items went "missing": a re-scan in a
    // new session created a duplicate instead of resurfacing the one you had).
    // The matched item is re-assigned to the CURRENT session + bumped to the top.
    // Only for barcode scans (photos/notes/receipts are each distinct); a re-scan
    // after commit/dismiss starts fresh — we only match `pending`.
    if (body.source_kind === "barcode" && body.barcode) {
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
          .orderBy("created_at", "desc")
          .executeTakeFirst());
      if (existing) {
        // Attach this scan's photo to the entry if it didn't have one (the re-scan
        // is "more info" for the same item, not a duplicate).
        const attachPhoto = hasPhoto && !existing.image_file_id;
        const bumped = await db
          .updateTable("core_scan_inbox_items")
          .set({
            quantity: sql`quantity + 1`,
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
          itemId: bumped.id,
          barcode: body.barcode,
          sourceKind: "barcode",
        });
        const token = bearer(req);
        const baseUrl = (req.headers["x-cobblr-base-url"] as string | undefined) ?? INTERNAL_API;
        if (!bumped.suggested_name && body.barcode && token) {
          // Re-scanning a still-UNIDENTIFIED item means "try again" — re-run
          // enrichment (force) instead of leaving it frozen. enrichBarcodeItem
          // cross-checks the (now-attached) photo against the resolved name itself.
          void enrichBarcodeItem({
            db,
            orgId: ctx.org.id,
            itemId: bumped.id,
            orgSlug: ctx.org.slug,
            bearer: token,
            baseUrl,
            upc: body.barcode,
            force: true,
          })
            .catch((err) => console.error("[core-scan] re-scan re-enrich threw:", (err as Error).message))
            .then(() =>
              platform().events.emit("core-scan.scan.enriched", { orgId: ctx.org.id, itemId: bumped.id }),
            );
        } else if (attachPhoto && bumped.suggested_name) {
          // Already named, and we just gave it a photo → run the barcode-vs-photo
          // cross-check so a wrong name gets flagged (and a one-tap fix offered).
          void crossCheckScanPhoto(ctx.org.id, bumped.id, bumped.suggested_name).catch((err) =>
            console.error("[core-scan] re-scan cross-check threw:", (err as Error).message),
          );
        }
        res.status(200).json(bumped);
        return;
      }
    }

    const inserted = await db
      .insertInto("core_scan_inbox_items")
      .values({
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
      })
      .returningAll()
      .executeTakeFirstOrThrow();

    void platform().events.emit("core-scan.scan.received", {
      orgId: ctx.org.id,
      itemId: inserted.id,
      barcode: inserted.barcode_text,
      sourceKind: inserted.source_kind,
    });

    // Race inline enrichment against the budget. Whichever lands
    // first wins the response; the other keeps running detached.
    const budget = body.enrich_ms ?? 12_000;
    const token = bearer(req);
    if (body.barcode && token) {
      const baseUrl =
        (req.headers["x-cobblr-base-url"] as string | undefined) ?? INTERNAL_API;
      const enrichTask = enrichBarcodeItem({
        db,
        orgId: ctx.org.id,
        itemId: inserted.id,
        orgSlug: ctx.org.slug,
        bearer: token,
        baseUrl,
        upc: body.barcode,
      })
        .catch((err) =>
          console.error("[core-scan] enrich threw:", (err as Error).message),
        )
        .then(() =>
          platform().events.emit("core-scan.scan.enriched", {
            orgId: ctx.org.id,
            itemId: inserted.id,
          }),
        );

      const timed = new Promise<"timeout">((resolve) =>
        setTimeout(() => resolve("timeout"), budget),
      );
      await Promise.race([enrichTask, timed]);
      // Read back the (possibly-enriched) row to return current state.
    } else if (body.source_kind === "url" && body.source_url && token) {
      // URL intake (incl. bulk paste): enrich DETACHED via the same pipeline —
      // classifyScanCode routes a URL to the vendor resolver, then web search.
      // Detached (not raced) so pasting many URLs stays snappy; the inbox poll
      // swaps in each result as it lands.
      const baseUrl = (req.headers["x-cobblr-base-url"] as string | undefined) ?? INTERNAL_API;
      void enrichBarcodeItem({
        db,
        orgId: ctx.org.id,
        itemId: inserted.id,
        orgSlug: ctx.org.slug,
        bearer: token,
        baseUrl,
        upc: body.source_url,
      })
        .catch((err) => console.error("[core-scan] url enrich threw:", (err as Error).message))
        .then(() => platform().events.emit("core-scan.scan.enriched", { orgId: ctx.org.id, itemId: inserted.id }));
    }
    // Photo-only scans (no barcode) are identified by the autonomous
    // photo-sort WIRE (core-scan.scan.received → core-scan:identify-photo,
    // seeded on enable) — fired detached via the emit above, so intake
    // stays instant and the user can edit / disable it on /bindings.

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

    // Intake owns the matchmaker: schedule it ONCE, detached, server-side —
    // it waits for enrichment (barcode overrun or the photo wire) and then
    // routes + fills fields. No webapp needs to be open; page loads never
    // re-trigger it (matched_at stamp + in-flight guard).
    if (token) {
      autoMatchWhenEnriched({
        orgId: ctx.org.id,
        orgSlug: ctx.org.slug,
        token,
        baseUrl: (req.headers["x-cobblr-base-url"] as string | undefined) ?? INTERNAL_API,
        itemId: inserted.id,
      });
    }
    res.status(201).json(fresh);
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
  scan_batch_id: z.string().uuid().optional(),
  scan_area: z.string().max(200).optional(),
  /** Explicit pre-filed location (the picker, or an integration that already
   *  resolved one). When set it wins over text extraction. */
  target_location_id: z.string().uuid().optional(),
});

inboxRouter.post(
  "/scan/note",
  asyncHandler(async (req, res) => {
    if (!requireRole(req, res, "owner", "admin", "member")) return;
    const parsed = NoteBody.safeParse(req.body);
    if (!parsed.success) return badBody(res, parsed.error);
    const body = parsed.data;

    const db = tenantDb(req);
    const ctx = tenantContext(req);
    const session = sessionUser(req);

    // Freeform capture often names the place too ("Logic analyzer in cabinet
    // 002"). Split the location phrase off the item and resolve it against the
    // workspace's locations, so the item lands pre-filed instead of the whole
    // sentence becoming its name. Best-effort: any failure leaves the raw text
    // as the name (the matchmaker still routes it).
    let itemName = body.text;
    let locationId: string | null = body.target_location_id ?? null;
    let scanArea: string | null = body.scan_area ?? null;
    if (!body.target_location_id) {
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
        const ex = extractLocation(body.text, lite);
        itemName = ex.itemText || body.text;
        locationId = ex.locationId;
        // Keep an explicit scan_area override; otherwise stamp the unresolved
        // phrase so the location is still captured as a hint for confirm.
        if (!scanArea && !ex.locationId && ex.locationPhrase) scanArea = ex.locationPhrase;
      } catch (err) {
        console.error("[core-scan] note location extraction failed:", (err as Error).message);
      }
    }

    const inserted = await db
      .insertInto("core_scan_inbox_items")
      .values({
        source_kind: "note",
        // The cleaned item phrase is the provisional name; the FULL raw text
        // stays as the matchmaker's description so no extraction context is lost.
        suggested_name: itemName.slice(0, 300),
        suggested_metadata: JSON.stringify({ description: body.text }) as never,
        scan_batch_id: body.scan_batch_id ?? null,
        scan_area: scanArea,
        target_location_id: locationId,
        created_by_user_id: session.id,
      })
      .returningAll()
      .executeTakeFirstOrThrow();

    void platform().events.emit("core-scan.scan.received", {
      orgId: ctx.org.id,
      itemId: inserted.id,
      barcode: null,
      sourceKind: "note",
    });

    // No enrichment to wait for — route immediately, detached. The web polls
    // /inbox for the candidates (same passive "AI is reading…" pulse as a scan).
    const token = bearer(req);
    if (token) {
      const baseUrl = (req.headers["x-cobblr-base-url"] as string | undefined) ?? INTERNAL_API;
      void matchItem({
        orgId: ctx.org.id, userId: sessionUser(req)?.id ?? null,
        orgSlug: ctx.org.slug,
        token,
        baseUrl,
        itemId: inserted.id,
        force: true,
      }).catch((err) => console.error("[core-scan] note match threw:", (err as Error).message));
    }
    res.status(201).json(inserted);
  }),
);

// ─────────────────────────── POST /scan/receipt ────────────────────
// Upload-a-receipt intake: a receipt PDF (or a photo of one) is parsed by
// core-ai into vendor + date + line items, then EACH line becomes its own
// scan-inbox row (source_kind "receipt") sharing a receipt_group_id. From there
// every line rides the same matchmaker + confirm flow a barcode/photo scan
// does — a receipt becomes N parts without retyping. The file is uploaded
// separately via core-files (like image_file_id), keeping this body small.

const ReceiptBody = z.object({ file_id: z.string().uuid() });

inboxRouter.post(
  "/scan/receipt",
  asyncHandler(async (req, res) => {
    if (!requireRole(req, res, "owner", "admin", "member")) return;
    const parsed = ReceiptBody.safeParse(req.body);
    if (!parsed.success) return badBody(res, parsed.error);

    const db = tenantDb(req);
    const ctx = tenantContext(req);
    const session = sessionUser(req);

    const result = await parseReceipt(ctx.org.id, parsed.data.file_id, session?.id ?? null);
    if (!result.ok) {
      // 422: the file was read but yielded no usable line items (bad scan, no
      // AI provider, not a receipt). The reason is user-facing.
      res.status(422).json({ error: { code: "receipt_unparsed", message: result.reason } });
      return;
    }
    const { receipt, method } = result;

    // One inbox row per line item, grouped by a shared receipt id so the UI can
    // show "<vendor> — N items" and triage them together. Vendor/date/currency
    // ride in metadata; the line price stays on the row for a later order rollup.
    // parse_method records whether the line came from a deterministic parse
    // (csv / pdf-table) or the AI fallback (ai-chat / ai-vision).
    const groupId = randomUUID();
    const baseMeta = {
      source: "receipt",
      receipt_group_id: groupId,
      receipt_vendor: receipt.vendor,
      receipt_date: receipt.date,
      receipt_currency: receipt.currency,
      parse_method: method,
    };

    const rows: Array<{ id: string }> = [];
    for (const line of receipt.items) {
      const inserted = await db
        .insertInto("core_scan_inbox_items")
        .values({
          source_kind: "receipt",
          suggested_name: line.description.slice(0, 300),
          quantity: Math.max(1, Math.round(line.qty || 1)),
          suggested_metadata: JSON.stringify({
            ...baseMeta,
            description: line.description,
            unit_price: line.unit_price,
            line_total: line.line_total,
          }) as never,
          created_by_user_id: session.id,
        })
        .returningAll()
        .executeTakeFirstOrThrow();
      rows.push(inserted);
      void platform().events.emit("core-scan.scan.received", {
        orgId: ctx.org.id,
        itemId: inserted.id,
        barcode: null,
        sourceKind: "receipt",
      });
    }

    // Route each line against the menu, detached — same as /scan/note. No
    // enrichment to wait for (we already have name + qty + price).
    const token = bearer(req);
    if (token) {
      const baseUrl = (req.headers["x-cobblr-base-url"] as string | undefined) ?? INTERNAL_API;
      for (const row of rows) {
        void matchItem({
          orgId: ctx.org.id, userId: sessionUser(req)?.id ?? null,
          orgSlug: ctx.org.slug,
          token,
          baseUrl,
          itemId: row.id,
          force: false,
        }).catch((err) => console.error("[core-scan] receipt match threw:", (err as Error).message));
      }
    }

    res.status(201).json({
      receipt: {
        vendor: receipt.vendor,
        date: receipt.date,
        currency: receipt.currency,
        total: receipt.total,
        item_count: rows.length,
        method,
      },
      items: rows,
    });
  }),
);

// ─────────────── POST /receipt-group/:groupId/confirm ───────────────
// Collapse a parsed receipt's pending lines into ONE purchases order: create the
// order (vendor + date + total from the group), then confirm EACH line through
// the normal per-item /confirm (which creates/matches the part) and attach the
// new part to the order as a line item. So a receipt becomes one purchase order
// with N line items, not N orphan parts. The receipt_group_id stamped at parse
// time is the join key. Lines already confirmed/discarded individually are
// simply not pending, so they're skipped — you can still triage line-by-line
// first, then roll up whatever remains.
//
// Degrades gracefully: if the purchases module isn't enabled (the order create
// fails), the lines are still confirmed into parts — just without an order.

const ReceiptGroupConfirm = z.object({
  target_module: z.string().min(1).max(80).optional(),
  target_kind: z.string().min(1).max(80).optional(),
  instance: z.string().regex(/^[a-z0-9][a-z0-9-]*$/).max(80).optional(),
  location_id: z.string().uuid().optional(),
});

inboxRouter.post(
  "/receipt-group/:groupId/confirm",
  asyncHandler(async (req, res) => {
    if (!requireRole(req, res, "owner", "admin", "member")) return;
    const groupId = req.params.groupId;
    if (!groupId) {
      res.status(400).json({ error: { code: "missing_id", message: "groupId required" } });
      return;
    }
    const parsed = ReceiptGroupConfirm.safeParse(req.body ?? {});
    if (!parsed.success) return badBody(res, parsed.error);
    const db = tenantDb(req);
    const ctx = tenantContext(req);
    const token = bearer(req);
    if (!token) {
      res.status(401).json({ error: { code: "no_auth", message: "Bearer token required" } });
      return;
    }
    const baseUrl = (req.headers["x-cobblr-base-url"] as string | undefined) ?? INTERNAL_API;

    // The group's still-pending lines, oldest first (preserves receipt order).
    const rows = await db
      .selectFrom("core_scan_inbox_items")
      .selectAll()
      .where(sql<boolean>`suggested_metadata->>'receipt_group_id' = ${groupId}`)
      .where("status", "in", ["pending", "enriching"])
      .where("source_kind", "=", "receipt")
      .orderBy("created_at", "asc")
      .execute();
    if (rows.length === 0) {
      res.status(404).json({ error: { code: "empty_group", message: "No pending receipt lines in this group." } });
      return;
    }

    const meta0 = (rows[0]!.suggested_metadata ?? {}) as Record<string, unknown>;
    const vendor = typeof meta0.receipt_vendor === "string" ? meta0.receipt_vendor : null;
    const orderedAt = typeof meta0.receipt_date === "string" ? meta0.receipt_date : null;
    // Order total = sum of line totals (fall back to unit_price × qty per line).
    let total = 0;
    let sawAmount = false;
    for (const row of rows) {
      const m = (row.suggested_metadata ?? {}) as Record<string, unknown>;
      const lt = typeof m.line_total === "number" ? m.line_total : null;
      const up = typeof m.unit_price === "number" ? m.unit_price : null;
      const qty = Number(row.quantity ?? 1);
      const amount = lt ?? (up != null ? up * qty : null);
      if (amount != null) {
        total += amount;
        sawAmount = true;
      }
    }

    const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };

    // Create the order (best-effort — skipped if purchases isn't enabled).
    let orderId: string | null = null;
    try {
      const orderRes = await fetch(`${baseUrl}/api/v1/orgs/${ctx.org.slug}/modules/purchases/orders`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          vendor,
          ordered_at: orderedAt,
          status: "arrived", // a receipt is an already-fulfilled purchase
          total_cost: sawAmount ? Number(total.toFixed(2)) : undefined,
          notes: "Imported from a receipt.",
          metadata: { receipt_group_id: groupId, source: "receipt" },
        }),
      });
      if (orderRes.ok) {
        orderId = ((await orderRes.json()) as { id: string }).id;
      } else {
        console.warn(`[core-scan] receipt PO create skipped (${orderRes.status}) — purchases disabled?`);
      }
    } catch (err) {
      console.warn("[core-scan] receipt PO create threw:", (err as Error).message);
    }

    // Confirm each line into a part (reusing the per-item confirm), then attach
    // the new part to the order.
    const confirmed: Array<Record<string, unknown>> = [];
    for (const row of rows) {
      const confirmBody: Record<string, unknown> = {};
      if (parsed.data.target_module && parsed.data.target_kind) {
        confirmBody.target_module = parsed.data.target_module;
        confirmBody.target_kind = parsed.data.target_kind;
      }
      if (parsed.data.instance) confirmBody.instance = parsed.data.instance;
      if (parsed.data.location_id) confirmBody.location_id = parsed.data.location_id;

      const cRes = await fetch(
        `${baseUrl}/api/v1/orgs/${ctx.org.slug}/modules/core-scan/inbox/${row.id}/confirm`,
        { method: "POST", headers, body: JSON.stringify(confirmBody) },
      );
      if (!cRes.ok) {
        confirmed.push({ itemId: row.id, error: `confirm_${cRes.status}` });
        continue;
      }
      const created = ((await cRes.json()) as { created?: { id?: string } }).created;
      const partId = created?.id ?? null;
      if (orderId && partId) {
        const m = (row.suggested_metadata ?? {}) as Record<string, unknown>;
        await fetch(`${baseUrl}/api/v1/orgs/${ctx.org.slug}/modules/purchases/orders/${orderId}/items`, {
          method: "POST",
          headers,
          body: JSON.stringify({
            part_id: partId,
            description: row.suggested_name ?? undefined,
            qty: Number(row.quantity ?? 1),
            unit_cost: typeof m.unit_price === "number" ? m.unit_price : undefined,
          }),
        }).catch((err) => console.warn("[core-scan] receipt PO add-item threw:", (err as Error).message));
      }
      confirmed.push({ itemId: row.id, partId });
    }

    res.json({ order_id: orderId, vendor, confirmed });
  }),
);

// ─────────────────────────── GET /inbox ────────────────────────────

const ListQuery = z.object({
  status: z.enum(["pending", "enriching", "resolved", "discarded"]).optional(),
  source_kind: z.enum(["barcode", "photo", "url", "receipt"]).optional(),
  batch_id: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  /** Opaque keyset cursor: page backwards through created_at-desc, no cap. */
  cursor: z.string().optional(),
});

// Keyset cursor over (created_at, id) — stable even with duplicate timestamps.
function encodeCursor(ts: Date | string, id: string): string {
  const iso = typeof ts === "string" ? ts : ts.toISOString();
  return Buffer.from(`${iso}|${id}`, "utf8").toString("base64url");
}
function decodeCursor(c: string): { ts: Date; id: string } | null {
  try {
    const [iso, id] = Buffer.from(c, "base64url").toString("utf8").split("|");
    if (!iso || !id) return null;
    const ts = new Date(iso);
    return Number.isNaN(ts.getTime()) ? null : { ts, id };
  } catch {
    return null;
  }
}

inboxRouter.get(
  "/inbox",
  asyncHandler(async (req, res) => {
    const q = ListQuery.safeParse(req.query);
    if (!q.success) return badBody(res, q.error);
    const db = tenantDb(req);
    const { status, source_kind, batch_id, limit, cursor } = q.data;
    let query = db
      .selectFrom("core_scan_inbox_items")
      .selectAll()
      .orderBy("created_at", "desc")
      .orderBy("id", "desc")
      .limit(limit);
    // Default scope: hide discarded items in the standard list.
    if (status) query = query.where("status", "=", status);
    else query = query.where("status", "!=", "discarded");
    if (source_kind) query = query.where("source_kind", "=", source_kind);
    if (batch_id) query = query.where("scan_batch_id", "=", batch_id);
    const c = cursor ? decodeCursor(cursor) : null;
    if (c) {
      query = query.where((eb) =>
        eb.or([
          eb("created_at", "<", c.ts),
          eb.and([eb("created_at", "=", c.ts), eb("id", "<", c.id)]),
        ]),
      );
    }
    const items = await query.execute();
    const last = items[items.length - 1];
    const next_cursor = items.length === limit && last ? encodeCursor(last.created_at, last.id) : null;
    // Total (for the header) only on the first page — it doesn't change per page.
    let total: number | undefined;
    if (!cursor) {
      let cq = db.selectFrom("core_scan_inbox_items").select((eb) => eb.fn.countAll().as("n"));
      if (status) cq = cq.where("status", "=", status);
      else cq = cq.where("status", "!=", "discarded");
      if (source_kind) cq = cq.where("source_kind", "=", source_kind);
      if (batch_id) cq = cq.where("scan_batch_id", "=", batch_id);
      const row = await cq.executeTakeFirst();
      total = Number(row?.n ?? 0);
    }
    res.json({ items, next_cursor, ...(total !== undefined ? { total } : {}) });
  }),
);

inboxRouter.get(
  "/inbox/:id",
  asyncHandler(async (req, res) => {
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
    res.json(row);
  }),
);

// ─────────────────────────── PATCH /inbox/:id ──────────────────────
// Light edits the camera modal makes in-the-moment: the quantity stepper,
// and an optional name correction. Triage/commit still happens on /scan.

const PatchBody = z.object({
  quantity: z.number().int().min(1).max(100_000).optional(),
  name: z.string().min(1).max(160).optional(),
  // Set/clear the filing location on an existing item (bulk "Set location" in
  // triage stamps the same value across a selection). null clears it.
  target_location_id: z.string().uuid().nullable().optional(),
  // Is this the ITEM (possibly in its box) or an EMPTY box you keep?
  // Rides suggested_metadata.box_state and lands on the entity at confirm.
  box_state: z.enum(["item-in-box", "empty-box"]).nullable().optional(),
  // "Looks fine" — a human eyeballed a ⚠-flagged item; drop it from needs-review.
  reviewed: z.boolean().optional(),
});

inboxRouter.patch(
  "/inbox/:id",
  asyncHandler(async (req, res) => {
    if (!requireRole(req, res, "owner", "admin", "member")) return;
    const id = req.params.id;
    if (!id) {
      res.status(400).json({ error: { code: "missing_id", message: "id required" } });
      return;
    }
    const parsed = PatchBody.safeParse(req.body);
    if (!parsed.success) return badBody(res, parsed.error);
    const patch: Record<string, unknown> = { updated_at: new Date() };
    if (parsed.data.quantity !== undefined) patch.quantity = parsed.data.quantity;
    if (parsed.data.name !== undefined) patch.suggested_name = parsed.data.name;
    if (parsed.data.target_location_id !== undefined) patch.target_location_id = parsed.data.target_location_id;
    const db = tenantDb(req);
    // Metadata-riders (box_state / reviewed): merge into suggested_metadata
    // without clobbering the rest of the blob.
    if (parsed.data.box_state !== undefined || parsed.data.reviewed !== undefined) {
      const cur = await db
        .selectFrom("core_scan_inbox_items")
        .select("suggested_metadata")
        .where("id", "=", id)
        .executeTakeFirst();
      const meta = ((cur?.suggested_metadata ?? {}) as Record<string, unknown>) ?? {};
      if (parsed.data.box_state !== undefined) {
        if (parsed.data.box_state === null) delete meta.box_state;
        else meta.box_state = parsed.data.box_state;
      }
      if (parsed.data.reviewed !== undefined) meta.reviewed = parsed.data.reviewed;
      patch.suggested_metadata = JSON.stringify(meta);
    }
    // Capture the prior name first: renaming a barcode item is a correction we
    // feed back to the shared Barcode Intelligence DB (below), and we need the
    // value the resolver gave to record what was wrong.
    const prior =
      parsed.data.name !== undefined
        ? await db
            .selectFrom("core_scan_inbox_items")
            .select(["barcode_text", "suggested_name"])
            .where("id", "=", id)
            .executeTakeFirst()
        : undefined;
    const row = await db
      .updateTable("core_scan_inbox_items")
      .set(patch)
      .where("id", "=", id)
      .returningAll()
      .executeTakeFirst();
    if (!row) {
      res.status(404).json({ error: { code: "not_found", message: "inbox item not found" } });
      return;
    }

    // An inline rename of a barcode item ALSO propagates to the Barcode
    // Intelligence DB — the resolver's name was wrong and the human's is truth,
    // so the next scan of this UPC (any workspace) gets the fix. Mirrors the
    // confirm-time report; reportBarcodeCorrection guards trivial edits. Inert
    // unless the resolver + a correction token are configured.
    if (prior?.barcode_text && parsed.data.name !== undefined && parsed.data.name.trim()) {
      void reportBarcodeCorrection({
        upc: prior.barcode_text,
        field: "title",
        was: prior.suggested_name,
        now: parsed.data.name.trim(),
        userId: sessionUser(req).id,
      });
    }

    // Manual-name fallback: when the user NAMES a previously-unidentified item
    // (a bare photo on a no-vision workspace — see enrich-photo's "fill in
    // manually"), re-route it through the matchmaker so the heuristic (or AI)
    // suggests a table + fills fields, instead of leaving them to pick. Detached,
    // forced (the row had no name, so it was never matched). The web polls /inbox.
    const token = bearer(req);
    if (parsed.data.name !== undefined && parsed.data.name.trim() && token) {
      const ctx = tenantContext(req);
      const baseUrl = (req.headers["x-cobblr-base-url"] as string | undefined) ?? INTERNAL_API;
      void matchItem({
        orgId: ctx.org.id, userId: sessionUser(req)?.id ?? null,
        orgSlug: ctx.org.slug,
        token,
        baseUrl,
        itemId: id,
        force: true,
      }).catch((err) => console.error("[core-scan] re-match after rename threw:", (err as Error).message));
      // Name changed → the catalog image likely shows the OLD product; refresh it
      // to match the new name (detached, best-effort).
      if (prior?.suggested_name !== parsed.data.name.trim()) {
        void refreshCatalogImageByName(
          ctx.org.id,
          id,
          parsed.data.name.trim(),
          (row.suggested_manufacturer as string | null) ?? null,
        ).catch((err) => console.error("[core-scan] catalog refresh after rename threw:", (err as Error).message));
      }
    }
    res.json(row);
  }),
);

// ──────────────────────── POST /inbox/:id/confirm ──────────────────

const ConfirmBody = z.object({
  /** Optional — when absent, routed from the identify's asset/part hint
   *  (suggested_metadata.entity_type): asset → assets:asset, else
   *  inventory:part. Both must be given together to override. */
  target_module: z.string().min(1).max(80).optional(),
  target_kind: z.string().min(1).max(80).optional(),
  /** Name override. Falls back to suggested_name if absent. */
  name: z.string().min(1).max(160).optional(),
  location_id: z.string().uuid().optional(),
  /** Quantity override. Falls back to the inbox row's quantity. */
  quantity: z.number().nonnegative().optional(),
  /** Module-specific extras forwarded verbatim to the create endpoint. */
  extras: z.record(z.unknown()).optional(),
  /** Tags to attach to the created entity (session-theme "tag them all", or a
   *  manual pick). Union'd with any pending_tags stashed on the item. */
  tags: z.array(z.string().min(1).max(60)).max(20).optional(),
  /** Route into a specific module INSTANCE (e.g. a food-skinned "pantry"
   *  instance of inventory) instead of the module's default instance. The
   *  workspace-level instance slug; the platform's instance router resolves
   *  it to (module, instance) and scopes the create. Absent → default. */
  instance: z.string().regex(/^[a-z0-9][a-z0-9-]*$/).max(80).optional(),
  /** Platform-admin only: also record this commit as a matchmaker eval case
   *  (the corrected answer is the ground truth). Best-effort; ignored for
   *  non-admins. See docs/operations/ai-prompt-eval-harness.md (P2). */
  save_eval_case: z.boolean().optional(),
  /** Optional note / hard-case label stored on the captured eval case. */
  eval_note: z.string().max(200).optional(),
});

// (The per-kind create endpoint + quantity-field name are now DECLARED by the
//  owning module via platform().entities.registerScannable and read at commit
//  time — core-scan no longer hardcodes them. Audit 2026-06-26 follow-up.)

/** Route a draft to its target kind: an explicit choice wins; otherwise match
 *  the identify's noun hint (entity_type, e.g. "asset"/"part") to a registered
 *  scannable's noun, else the registry's declared default. Registry-driven — no
 *  module names hardcoded here. (Audit burn-down.) */
function resolveTargetKind(
  explicitModule: string | undefined,
  explicitKind: string | undefined,
  entityType: unknown,
): { module: string; kind: string } {
  if (explicitModule && explicitKind) return { module: explicitModule, kind: explicitKind };
  const scannables = platform().entities.listScannable();
  const hint = typeof entityType === "string" ? entityType : undefined;
  const chosen =
    (hint ? scannables.find((s) => s.noun === hint) : undefined) ??
    scannables.find((s) => s.default) ??
    scannables[0];
  if (!chosen) return { module: "", kind: "" }; // no scannables → caller 400s
  const [module, kind] = chosen.kind.split(":");
  return { module: module!, kind: kind! };
}

inboxRouter.post(
  "/inbox/:id/confirm",
  asyncHandler(async (req, res) => {
    if (!requireRole(req, res, "owner", "admin", "member")) return;
    const parsed = ConfirmBody.safeParse(req.body);
    if (!parsed.success) return badBody(res, parsed.error);
    const id = req.params.id;
    if (!id) {
      res.status(400).json({ error: { code: "missing_id", message: "id required" } });
      return;
    }
    const db = tenantDb(req);
    const ctx = tenantContext(req);
    const token = bearer(req);
    if (!token) {
      res.status(401).json({ error: { code: "no_auth", message: "Bearer token required" } });
      return;
    }

    const row = await db
      .selectFrom("core_scan_inbox_items")
      .selectAll()
      .where("id", "=", id)
      .executeTakeFirst();
    if (!row) {
      res.status(404).json({ error: { code: "not_found", message: "inbox item not found" } });
      return;
    }
    if (row.status === "resolved") {
      res.status(409).json({
        error: { code: "already_resolved", message: "This item was already confirmed." },
      });
      return;
    }

    const meta = (row.suggested_metadata as Record<string, unknown> | null) ?? {};
    // Route to the right kind: explicit choice wins, else the identify's
    // asset/part hint (asset → assets:asset, else inventory:part).
    const target = resolveTargetKind(
      parsed.data.target_module,
      parsed.data.target_kind,
      (meta as { entity_type?: unknown }).entity_type,
    );
    const kindKey = `${target.module}:${target.kind}`;
    // The owning module declares its scan target (create endpoint + quantity
    // field) via registerScannable — core-scan reads it instead of a hardcoded
    // map. (Audit 2026-06-26 follow-up.)
    const scanTarget = platform().entities.getScannable(kindKey);
    if (!scanTarget) {
      res.status(400).json({
        error: {
          code: "unknown_target_kind",
          message: `${kindKey} is not a scan target — its module marks the kind scannable via platform().entities.registerScannable.`,
        },
      });
      return;
    }
    const createPath = scanTarget.createEndpoint;

    // Build the create body. Defaults from the suggestion + extras win.
    // The quantity rides on the kind's own field name (qty vs quantity).
    const qty = parsed.data.quantity ?? Number(row.quantity ?? 1);
    const qtyField = scanTarget.qtyField;
    // `extras.metadata` (the instance's custom fields the user filled on the
    // confirm form — colorway, fibre, …) is DEEP-merged into the scan metadata
    // so it doesn't wipe the barcode/sku/source we stamp for catalog re-match.
    const { metadata: extrasMetadata, ...restExtras } = (parsed.data.extras ?? {}) as Record<string, unknown>;
    // The matchmaker already mapped this scan onto the target's own fields
    // (colorway/fibre/weight for a yarn) — a confirm into that target gets
    // them BY DEFAULT, whichever surface confirms (the seeded form, the
    // camera's one-tap chip, the bare API). Anything the user supplied
    // (extras.metadata) wins per-key.
    const candidates =
      (row.suggested_candidates as Array<{
        instance?: string | null;
        module?: string;
        fields?: Record<string, unknown>;
      }> | null) ?? [];
    const matchedCandidate = parsed.data.instance
      ? candidates.find((c) => c.instance === parsed.data.instance)
      : (candidates.find((c) => !c.instance && c.module === target.module) ?? candidates[0]);
    const candidateFields = matchedCandidate?.fields ?? {};
    // The triage form posts EVERY input — an untouched one arrives as "".
    // Empty means "no answer", not "blank the suggestion": drop them so a
    // placeholder the user never typed over can't clobber the candidate.
    const typedMetadata = Object.fromEntries(
      Object.entries((extrasMetadata as Record<string, unknown> | undefined) ?? {}).filter(
        ([, v]) => v !== "" && v !== null && v !== undefined,
      ),
    );
    const body: Record<string, unknown> = {
      name: parsed.data.name ?? row.suggested_name ?? "Untitled",
      manufacturer: row.suggested_manufacturer ?? undefined,
      // A serial/service tag the vision read off the label → the destination
      // table's NATIVE serial_number field (inventory/assets/machines all
      // declare it; an unknown target routes it to metadata harmlessly). Native
      // key like manufacturer; a user-typed value in restExtras still wins below.
      ...((meta as { serial_number?: string }).serial_number
        ? { serial_number: (meta as { serial_number?: string }).serial_number }
        : {}),
      // Carry the SKU + barcode + source into metadata so a future
      // catalog-match step can find this entity.
      metadata: {
        barcode: row.barcode_text ?? undefined,
        sku: row.suggested_sku ?? undefined,
        category: (meta as { category?: string }).category ?? undefined,
        scan_source: (meta as { source?: string }).source ?? undefined,
        // Physical annotations the triage captured (scan-parity Epic D).
        pack_size: (meta as { pack_size?: number }).pack_size ?? undefined,
        box_state: (meta as { box_state?: string }).box_state ?? undefined,
        // Empty box: the scan location is the BOX's home, not the item's — say
        // so instead of silently mislocating the entity.
        ...((meta as { box_state?: string }).box_state === "empty-box" &&
        (row.scan_area || parsed.data.location_id)
          ? { box_note: `Empty box kept at: ${row.scan_area ?? "the scan location"}` }
          : {}),
        // Fields a scan-URL resolver seeded (e.g. a Polar spool's size /
        // batch_code). Generic: the kernel doesn't know the vendor — it
        // just carries whatever `fields` the resolver stamped. Matchmaker
        // candidate + user-typed values still win per-key below.
        ...((meta as { fields?: Record<string, unknown> }).fields ?? {}),
        ...candidateFields,
        ...typedMetadata,
      },
      ...(qtyField && qty ? { [qtyField]: qty } : {}),
      // Empty box → do NOT file the entity at the scan location: that's where
      // the BOX lives; the item itself is deployed elsewhere.
      ...(parsed.data.location_id && (meta as { box_state?: string }).box_state !== "empty-box"
        ? { location_id: parsed.data.location_id }
        : {}),
      ...restExtras,
    };

    // Re-issue through the api against the SAME bearer token so
    // requireAuth + withTenant + role gating fire on the target
    // endpoint.
    const baseUrl =
      (req.headers["x-cobblr-base-url"] as string | undefined) ?? INTERNAL_API;
    // An explicit instance routes through the platform instance dispatcher
    // (/instances/:name/items), which scopes the create to that instance of
    // the owning module. The kind still drives the qty-field mapping above —
    // an inventory instance keeps `qty`. Absent → the module's default path.
    const createUrl = parsed.data.instance
      ? `${baseUrl}/api/v1/orgs/${ctx.org.slug}/instances/${parsed.data.instance}/items`
      : `${baseUrl}/api/v1/orgs/${ctx.org.slug}/modules/${createPath}`;
    const doCreate = () =>
      fetch(createUrl, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      });
    let createRes = await doCreate();
    // Capture-first "one-tap materialize": you can scan into a flagship-bundle
    // shape before its module is enabled. If the create dead-ends on the
    // module-not-enabled gate, enable the target module (idempotent) and retry
    // once — so a scan files itself instead of erroring on a 409.
    if (createRes.status === 409) {
      const peek = await createRes.clone().text();
      if (/module_not_enabled/.test(peek)) {
        await fetch(`${baseUrl}/api/v1/orgs/${ctx.org.slug}/modules/${target.module}/enable`, {
          method: "POST",
          headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
          body: "{}",
        }).catch(() => {});
        createRes = await doCreate();
      }
    }
    if (!createRes.ok) {
      const errText = await createRes.text();
      // Surface the TARGET's own message (e.g. "Enable Inventory in Configuration
      // → Modules"), not just the bare status, so the error is actionable.
      let targetMsg: string | undefined;
      try {
        targetMsg = (JSON.parse(errText) as { error?: { message?: string } }).error?.message;
      } catch {
        /* non-JSON body */
      }
      res.status(createRes.status).json({
        error: {
          code: "create_failed",
          message: targetMsg ?? `Target create returned ${createRes.status}`,
          details: errText,
        },
      });
      return;
    }
    const created = (await createRes.json()) as { id: string };

    // Scan-into-container: if the item was scanned into a CONTAINER bin (a
    // server/asset or machine — not a location), place the created entity inside
    // it. Parallel to the location_id stamping in the create body above; the
    // container path writes a placement row after the create. Best-effort — a
    // bad container (ineligible kind / cycle) never fails the whole confirm; the
    // item is already created + filed.
    if (row.target_container_kind && row.target_container_id) {
      try {
        await platform().placement.place({
          orgId: ctx.org.id,
          containee: { kind: kindKey, id: created.id },
          container: { kind: row.target_container_kind, id: row.target_container_id },
          placedBy: sessionUser(req)?.id ?? null,
        });
      } catch (err) {
        console.warn(
          `[scan] placement into ${row.target_container_kind} failed:`,
          (err as Error).message,
        );
      }
    }

    // Session-theme / manual tags: attach each to the created entity via the
    // core-tags attach endpoint (creates the tag by name on the fly, idempotent
    // on tag+entity). pending_tags stashed by /inbox/apply-theme union with any
    // tags the confirm body carries. Best-effort — a tag failure never fails a
    // confirm.
    const stashedTags = ((row.suggested_metadata as { pending_tags?: unknown } | null)?.pending_tags);
    const tagNames = [
      ...new Set([
        ...(Array.isArray(stashedTags) ? stashedTags.map((t) => String(t)) : []),
        ...(parsed.data.tags ?? []),
      ]),
    ].filter((t) => t.trim());
    for (const tag_name of tagNames) {
      try {
        await fetch(`${baseUrl}/api/v1/orgs/${ctx.org.slug}/modules/core-tags/attachments`, {
          method: "POST",
          headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
          body: JSON.stringify({ tag_name, source_module: target.module, source_type: target.kind, source_id: created.id }),
        });
      } catch (err) {
        console.error(`[core-scan] confirm tag "${tag_name}" failed:`, (err as Error)?.message ?? err);
      }
    }

    // Attach the catalog image (if any) as the new entity's
    // gallery photo via core-files.
    if (row.catalog_image_file_id) {
      try {
        await fetch(`${baseUrl}/api/v1/orgs/${ctx.org.slug}/modules/core-files/attachments`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            file_id: row.catalog_image_file_id,
            source_module: target.module,
            source_type: target.kind,
            source_id: created.id,
            role: "gallery",
          }),
        });
        // Optionally also point image_path at the catalog photo — UNLESS the
        // item's identity is a colour swatch (a valid colour hex on the item,
        // e.g. a yarn's colourway). A generic internet photo of "a skein" then
        // suppresses the swatch the user actually wants (the thumbnail prefers a
        // photo over a colour). Keep the catalog photo in the gallery (attached
        // above), just don't make it the primary thumbnail. The user's own
        // uploaded photo still wins — this only skips the auto-catalog stamp.
        const committedColor = String(
          ((body.metadata as Record<string, unknown> | undefined)?.color ?? "") as string,
        ).trim();
        const hasColorSwatch = /^#[0-9a-fA-F]{3,8}$/.test(committedColor);
        // An instance-scoped entity is invisible to the bare module route (its
        // CRUD filters to the default instance), so the patch must ride the same
        // instance path the create used.
        const patchUrl = parsed.data.instance
          ? `${baseUrl}/api/v1/orgs/${ctx.org.slug}/instances/${parsed.data.instance}/items/${created.id}`
          : `${baseUrl}/api/v1/orgs/${ctx.org.slug}/modules/${createPath}/${created.id}`;
        if (!hasColorSwatch) {
          await fetch(patchUrl, {
            method: "PATCH",
            headers: {
              Authorization: `Bearer ${token}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              image_path: `/api/v1/orgs/${ctx.org.slug}/modules/core-files/files/${row.catalog_image_file_id}/raw`,
            }),
          });
        }
      } catch (err) {
        console.error("[core-scan] attach catalog image failed:", (err as Error).message);
      }
    }

    // Mark the inbox row resolved.
    const resolvedRow = await db
      .updateTable("core_scan_inbox_items")
      .set({
        status: "resolved",
        target_module: target.module,
        target_kind: target.kind,
        target_entity_id: created.id,
        resolved_at: new Date(),
        updated_at: new Date(),
      })
      .where("id", "=", id)
      .returningAll()
      .executeTakeFirstOrThrow();

    void platform().events.emit("core-scan.scan.confirmed", {
      orgId: ctx.org.id,
      itemId: id,
      targetModule: target.module,
      targetKind: target.kind,
      entityId: created.id,
    });

    // P2 eval-harness capture (platform-admin only, best-effort): the admin's
    // corrected commit IS the ground-truth answer. Record the perceived input +
    // the menu the model saw + the route/fields committed, so the matchmaker
    // golden set grows from real triage rather than hand-authoring. A capture
    // failure must never fail the commit. See docs/operations/ai-prompt-eval-harness.md.
    const sess = sessionUser(req);

    // Feed a scan-triage correction back to the shared Barcode Intelligence DB:
    // a barcode item renamed away from what the resolver returned means the
    // lookup was wrong (or missing) and the human's name is the truth. The next
    // scan of this UPC, in any workspace, then gets the fix. Fire-and-forget;
    // inert unless the resolver + a correction token are configured.
    if (row.barcode_text) {
      void reportBarcodeCorrection({
        upc: row.barcode_text,
        field: "title",
        was: row.suggested_name,
        now: String(body.name ?? ""),
        userId: sess.id,
      });
    }

    // Flywheel (scan-parity Epic D): committing an item whose barcode was
    // RECOVERED from the photo (ai-photo OCR) is a human confirmation of the
    // (barcode → identity) pair — safe to teach BIdb now. The auto-poison risk
    // that deferred this was an UNconfirmed OCR name; a commit is the opposite.
    if (row.barcode_text && (meta as { barcode_source?: string }).barcode_source === "ai-photo") {
      const confirmedName = String(body.name ?? row.suggested_name ?? "").trim();
      if (confirmedName) {
        void reportBarcodeCorrection({
          upc: row.barcode_text,
          field: "title",
          was: row.suggested_name,
          now: confirmedName,
          userId: sess.id,
          confirm: true,
        });
        if (row.suggested_manufacturer) {
          void reportBarcodeCorrection({
            upc: row.barcode_text,
            field: "brand",
            was: row.suggested_manufacturer,
            now: row.suggested_manufacturer,
            userId: sess.id,
            confirm: true,
          });
        }
      }
    }

    if (parsed.data.save_eval_case && sess.is_platform_admin) {
      try {
        const menu = await assembleMergedMenu(baseUrl, ctx.org.slug, token);
        await db
          .insertInto("core_scan_eval_cases")
          .values({
            inbox_item_id: id,
            surface: "matchmaker",
            perceived_input: JSON.stringify({
              name: row.suggested_name ?? "",
              manufacturer: row.suggested_manufacturer,
              category: (meta as { category?: string }).category ?? null,
              description: (meta as { description?: string }).description ?? null,
              entityType: (meta as { entity_type?: "asset" | "part" }).entity_type ?? null,
              barcode: row.barcode_text,
            }) as never,
            scan_menu: JSON.stringify(menu) as never,
            candidates: JSON.stringify(row.suggested_candidates ?? []) as never,
            expected: JSON.stringify({
              route: { module: target.module, instance: parsed.data.instance ?? null },
              fields: (extrasMetadata as Record<string, unknown> | undefined) ?? {},
              name: body.name,
            }) as never,
            note: parsed.data.eval_note ?? null,
            created_by_user_id: sess.id,
          })
          .execute();
      } catch (err) {
        console.error("[core-scan] eval-case capture failed:", (err as Error).message);
      }
    }

    res.json({ item: resolvedRow, created });
  }),
);

// ──────────── POST /inbox/:id/confirm-into-location ───────────────
// The paired-scan flow: the active bin's QR said WHICH record ("Bin 17");
// this scanned UPC says WHAT it is ("Sterilite 6qt"). Instead of creating a
// new entity filed INTO the bin, the product identity lands on the bin's own
// core-locations record — structured container_* keys merged into its
// metadata, the catalog photo as its image, the product name as its
// description when none is set. The location's NAME is the user's own label
// ("Bin 17") and is never overwritten. All writes ride core-locations' HTTP
// surface with the caller's bearer, so role gating + isolation hold.

inboxRouter.post(
  "/inbox/:id/confirm-into-location",
  asyncHandler(async (req, res) => {
    if (!requireRole(req, res, "owner", "admin", "member")) return;
    const id = req.params.id;
    if (!id) {
      res.status(400).json({ error: { code: "missing_id", message: "id required" } });
      return;
    }
    const db = tenantDb(req);
    const ctx = tenantContext(req);
    const row = await db
      .selectFrom("core_scan_inbox_items")
      .selectAll()
      .where("id", "=", id)
      .executeTakeFirst();
    if (!row) {
      res.status(404).json({ error: { code: "not_found", message: "inbox item not found" } });
      return;
    }
    if (row.status === "resolved") {
      res.status(409).json({
        error: { code: "already_resolved", message: "This item was already confirmed." },
      });
      return;
    }
    // The bin: an explicit body override, else the one the scan was filed into.
    const locId =
      z.string().uuid().safeParse((req.body as { location_id?: unknown } | undefined)?.location_id)
        .data ?? row.target_location_id;
    if (!locId) {
      res.status(400).json({
        error: {
          code: "no_active_bin",
          message: "This scan wasn't filed into a bin — scan the bin's QR first, then the product barcode.",
        },
      });
      return;
    }

    // The bin is written through its owning module's registered entity WRITER
    // (the same sanctioned seam the sync engine uses) — module validation +
    // events fire; core-scan never touches another module's table or URL.
    const locationKind = "core-locations:location";
    const writer = platform().entities.getWriter(locationKind);
    if (!writer?.read) {
      res.status(501).json({
        error: { code: "no_location_writer", message: "Locations module is not available." },
      });
      return;
    }
    const loc = await writer.read(ctx.org.id, locId);
    if (!loc) {
      res.status(404).json({ error: { code: "not_found", message: "bin not found" } });
      return;
    }

    const meta = (row.suggested_metadata as Record<string, unknown> | null) ?? {};
    // The writer replaces metadata wholesale — merge over the current blob so
    // the identity never wipes what's already on the bin. container_* is the
    // structured face; barcode/sku let a future catalog re-match find it.
    const identity: Record<string, unknown> = {
      container_product: row.suggested_name ?? undefined,
      container_brand: row.suggested_manufacturer ?? undefined,
      barcode: row.barcode_text ?? undefined,
      sku: row.suggested_sku ?? undefined,
      ...(typeof (meta as { category?: unknown }).category === "string"
        ? { container_category: (meta as { category?: string }).category }
        : {}),
    };
    for (const k of Object.keys(identity)) if (identity[k] === undefined) delete identity[k];
    const currentMeta = (loc.metadata as Record<string, unknown> | null) ?? {};
    const fields: Record<string, unknown> = { metadata: { ...currentMeta, ...identity } };
    if (!loc.description && row.suggested_name) fields.description = row.suggested_name;
    if (!loc.image_path && row.catalog_image_file_id) {
      fields.image_path = `/api/v1/orgs/${ctx.org.slug}/modules/core-files/files/${row.catalog_image_file_id}/raw`;
    }
    await writer.update(ctx.org.id, locId, fields);

    const [locModule, locKind] = locationKind.split(":") as [string, string];
    const resolvedRow = await db
      .updateTable("core_scan_inbox_items")
      .set({
        status: "resolved",
        target_module: locModule,
        target_kind: locKind,
        target_entity_id: locId,
        resolved_at: new Date(),
        updated_at: new Date(),
      })
      .where("id", "=", id)
      .returningAll()
      .executeTakeFirstOrThrow();

    void platform().events.emit("core-scan.scan.confirmed", {
      orgId: ctx.org.id,
      itemId: id,
      targetModule: locModule,
      targetKind: locKind,
      entityId: locId,
    });

    res.json({ item: resolvedRow, location_id: locId });
  }),
);

// ─────────────────────── POST /inbox/:id/discard ──────────────────

inboxRouter.post(
  "/inbox/:id/discard",
  asyncHandler(async (req, res) => {
    if (!requireRole(req, res, "owner", "admin", "member")) return;
    const id = req.params.id;
    if (!id) {
      res.status(400).json({ error: { code: "missing_id", message: "id required" } });
      return;
    }
    const db = tenantDb(req);
    const ctx = tenantContext(req);
    const row = await db
      .updateTable("core_scan_inbox_items")
      .set({ status: "discarded", updated_at: new Date() })
      .where("id", "=", id)
      .returningAll()
      .executeTakeFirst();
    if (!row) {
      res.status(404).json({ error: { code: "not_found", message: "inbox item not found" } });
      return;
    }
    void platform().events.emit("core-scan.scan.discarded", {
      orgId: ctx.org.id,
      itemId: id,
    });
    res.json(row);
  }),
);

// ─────────────────────── POST /inbox/:id/restore ──────────────────
// Un-discard a soft-deleted scan back into the pending queue (the "recently
// deleted" undo). Only acts on a discarded row; its enriched data was preserved
// by the soft delete, so it comes back exactly as it left.
inboxRouter.post(
  "/inbox/:id/restore",
  asyncHandler(async (req, res) => {
    if (!requireRole(req, res, "owner", "admin", "member")) return;
    const id = req.params.id;
    if (!id) {
      res.status(400).json({ error: { code: "missing_id", message: "id required" } });
      return;
    }
    const db = tenantDb(req);
    const row = await db
      .updateTable("core_scan_inbox_items")
      // Restoring re-queues to the TOP (bump created_at, the list's sort key) so
      // the recovered item is where the user expects it, not buried at its old
      // position — the same "where did it go?" trap as a deduped re-scan.
      .set({ status: "pending", created_at: new Date(), updated_at: new Date() })
      .where("id", "=", id)
      .where("status", "=", "discarded")
      .returningAll()
      .executeTakeFirst();
    if (!row) {
      res.status(404).json({ error: { code: "not_found", message: "discarded inbox item not found" } });
      return;
    }
    res.json(row);
  }),
);

/** Append a triage-action entry to an item's per-item history
 *  (suggested_metadata.history, last 8) — the user-visible "what you did"
 *  timeline shown in the source panel. Best-effort; history is cosmetic. */
async function appendScanHistory(
  db: ReturnType<typeof tenantDb>,
  id: string,
  entry: {
    action: "rerun" | "wrong" | "enrich" | "confirm" | "combine" | "attached" | "split" | "unconfirm";
    note?: string | null;
  },
): Promise<void> {
  try {
    const cur = await db
      .selectFrom("core_scan_inbox_items")
      .select("suggested_metadata")
      .where("id", "=", id)
      .executeTakeFirst();
    const meta = ((cur?.suggested_metadata ?? {}) as Record<string, unknown>) ?? {};
    const prev = Array.isArray((meta as { history?: unknown }).history)
      ? ((meta as { history: unknown[] }).history as unknown[])
      : [];
    const e: Record<string, unknown> = { action: entry.action, at: new Date().toISOString() };
    if (entry.note && entry.note.trim()) e.note = entry.note.trim();
    await db
      .updateTable("core_scan_inbox_items")
      .set({ suggested_metadata: JSON.stringify({ ...meta, history: [...prev, e].slice(-8) }) as never })
      .where("id", "=", id)
      .execute();
  } catch {
    /* best-effort */
  }
}

// ─────────────────────── POST /inbox/:id/rerun-ai ─────────────────

const RerunBody = z.object({
  /** The user's research hint ("model number is X", "it's the 5mm one") —
   *  persisted into suggested_metadata.user_hint, which rides
   *  lookup_metadata into the matchmaker prompt as the authoritative
   *  correction. */
  hint: z.string().trim().max(500).optional(),
  /** "This is wrong" — re-resolve across ALL sources + the web, treat the result
   *  as authoritative (distrust the flagged answer), and write the correction
   *  back to BIdb. */
  wrong: z.boolean().optional(),
  /** "Right product, but needs detail" — keep the identity, but web-identify
   *  across the board and accept a fuller name/spec/brand for the same item. */
  enrich: z.boolean().optional(),
  /** The user photographed the product to (re)identify it — attach this photo and
   *  force the VISION path even when a (wrong) barcode is already on the item. The
   *  phone's "Not it — photograph it": a junk/non-product barcode that no source
   *  can fix gets identified from the package instead. */
  image_file_id: z.string().uuid().optional(),
});

inboxRouter.post(
  "/inbox/:id/rerun-ai",
  asyncHandler(async (req, res) => {
    if (!requireRole(req, res, "owner", "admin", "member")) return;
    const id = req.params.id;
    if (!id) {
      res.status(400).json({ error: { code: "missing_id", message: "id required" } });
      return;
    }
    const db = tenantDb(req);
    const ctx = tenantContext(req);
    const token = bearer(req);
    if (!token) {
      res.status(401).json({ error: { code: "no_auth", message: "Bearer token required" } });
      return;
    }
    const row = await db
      .selectFrom("core_scan_inbox_items")
      .selectAll()
      .where("id", "=", id)
      .executeTakeFirst();
    if (!row) {
      res.status(404).json({ error: { code: "not_found", message: "inbox item not found" } });
      return;
    }
    // Record the triage action in the item's history (covers the photo branch's
    // early return too) so the source panel can show "you asked for more detail".
    const rerun = RerunBody.safeParse(req.body ?? {}).data;
    await appendScanHistory(db, id, {
      action: rerun?.wrong ? "wrong" : rerun?.enrich ? "enrich" : "rerun",
      note: rerun?.hint,
    });
    // The user photographed the product to re-identify it (phone "Not it —
    // photograph it"). Attach the new photo and force the vision path below, even
    // if a (wrong) barcode is sitting on the item — vision off the package beats a
    // junk/non-product code no source can fix.
    const attachedPhoto = rerun?.image_file_id;
    if (attachedPhoto) {
      await db
        .updateTable("core_scan_inbox_items")
        .set({ image_file_id: attachedPhoto, updated_at: new Date() })
        .where("id", "=", id)
        .execute();
      row.image_file_id = attachedPhoto;
    }

    if (!row.barcode_text || attachedPhoto) {
      // Photo-only path → re-run the vision identify. The vision+match pass runs
      // tens of seconds over the edge relay, so we DON'T hold the request for it
      // (holding past ~100s 524s behind cobblr.me's Cloudflare tunnel). Instead we
      // kick the work off detached and return immediately; the web shows a local
      // "AI reading…" state on this card and the inbox poll surfaces the result.
      // The detached work runs on its OWN freshly-acquired tenant db (the request
      // pool is gone once we respond) — enrichPhotoItem re-acquires after its
      // vision call and matchItem re-acquires its own, so neither touches a reaped
      // pool.
      if (!row.image_file_id) {
        res.status(400).json({ error: { code: "no_input", message: "item has neither a barcode nor a photo" } });
        return;
      }
      const imageFileId = row.image_file_id;
      const baseUrl = (req.headers["x-cobblr-base-url"] as string | undefined) ?? INTERNAL_API;
      const photoHint = rerun?.hint;
      // Stamp the hint as user_hint NOW (before the detached work) so it rides
      // into the matchmaker too — the barcode path stamps below, but the photo
      // path returns before it, which silently dropped the hint entirely.
      if (photoHint) {
        const meta = ((row.suggested_metadata ?? {}) as Record<string, unknown>) ?? {};
        await db
          .updateTable("core_scan_inbox_items")
          .set({ suggested_metadata: JSON.stringify({ ...meta, user_hint: photoHint }) as never, updated_at: new Date() })
          .where("id", "=", id)
          .execute();
      }
      // "This is wrong" on a photo: the user-picked catalog image was anchoring
      // the identity (the re-read kept seeing the picked product). Drop its lock
      // + refs so the re-identify — and the user's hint — aren't fighting a stale
      // image. A plain hint/enrich keeps the picked image (it's still the item).
      if (rerun?.wrong) {
        const meta = ((row.suggested_metadata ?? {}) as Record<string, unknown>) ?? {};
        delete (meta as { catalog_image_user_set?: unknown }).catalog_image_user_set;
        await db
          .updateTable("core_scan_inbox_items")
          .set({
            catalog_image_file_id: null,
            catalog_image_url: null,
            suggested_metadata: JSON.stringify({ ...meta, ...(photoHint ? { user_hint: photoHint } : {}) }) as never,
            updated_at: new Date(),
          })
          .where("id", "=", id)
          .execute();
      }
      // Capture the caller now — the detached work runs after the request, so
      // route the AI through their personal connection (the 'own' path).
      const uid = sessionUser(req).id;
      void (async () => {
        const workDb = (await platform().tenants.getDb(ctx.org.id)) as unknown as typeof db;
        await enrichPhotoItem({ db: workDb, orgId: ctx.org.id, itemId: id, imageFileId, userId: uid, force: true, hint: photoHint });
        void platform().events.emit("core-scan.scan.enriched", { orgId: ctx.org.id, itemId: id });
        await matchItem({ orgId: ctx.org.id, userId: sessionUser(req)?.id ?? null, orgSlug: ctx.org.slug, token, baseUrl, itemId: id, force: true });
      })().catch((err) => {
        console.error("[core-scan] photo rerun-ai work failed:", (err as Error)?.message ?? err);
      });
      res.json(row);
      return;
    }

    // Bypass the cache by clearing the cache row for this UPC.
    try {
      await db
        .deleteFrom("core_scan_barcode_cache")
        .where("upc", "=", row.barcode_text)
        .execute();
    } catch {
      /* non-fatal */
    }

    const baseUrl =
      (req.headers["x-cobblr-base-url"] as string | undefined) ?? INTERNAL_API;
    await enrichBarcodeItem({
      db,
      orgId: ctx.org.id,
      itemId: id,
      orgSlug: ctx.org.slug,
      bearer: token,
      baseUrl,
      upc: row.barcode_text,
      // Rerun means RE-ASK: skip the tenant AND shared caches (deleting
      // only the tenant row left the shared cache answering with the
      // stale result — the box resolver was never consulted again).
      force: true,
      // "This is wrong" → web-identify + write the correction back to BIdb;
      // "needs detail" → keep identity, fill it in. Either way fold in the note.
      wrong: rerun?.wrong,
      enrich: rerun?.enrich,
      hint: rerun?.hint,
    });

    // Stamp the user's hint AFTER enrichment (which rewrites
    // suggested_metadata) so the matchmaker sees it as user_hint.
    const hint = rerun?.hint;
    if (hint) {
      const cur = await db
        .selectFrom("core_scan_inbox_items")
        .select("suggested_metadata")
        .where("id", "=", id)
        .executeTakeFirst();
      const meta = ((cur?.suggested_metadata ?? {}) as Record<string, unknown>) ?? {};
      await db
        .updateTable("core_scan_inbox_items")
        .set({
          suggested_metadata: JSON.stringify({ ...meta, user_hint: hint }) as never,
          updated_at: new Date(),
        })
        .where("id", "=", id)
        .execute();
    }

    // Rerun = re-ask everything: the match runs INLINE so the response
    // already carries the re-ranked candidates + reconciliation notes
    // (the web's spinner spans this await — honest end-to-end).
    await matchItem({
      orgId: ctx.org.id, userId: sessionUser(req)?.id ?? null,
      orgSlug: ctx.org.slug,
      token,
      baseUrl,
      itemId: id,
      force: true,
    });

    const fresh = await db
      .selectFrom("core_scan_inbox_items")
      .selectAll()
      .where("id", "=", id)
      .executeTakeFirstOrThrow();
    res.json(fresh);
  }),
);

// ─────────────────── GET /inbox/:id/photo-options ───────────────────
// Alternative catalog photos: a DDG image search on the item's resolved
// name (the "OTHER PHOTO OPTIONS" strip). Read-only; picking one
// goes through POST /inbox/:id/catalog-image.

inboxRouter.get(
  "/inbox/:id/photo-options",
  asyncHandler(async (req, res) => {
    if (!requireRole(req, res, "owner", "admin", "member")) return;
    const id = req.params.id;
    const db = tenantDb(req);
    const row = await db
      .selectFrom("core_scan_inbox_items")
      .select(["suggested_name", "suggested_manufacturer", "barcode_text", "suggested_candidates"])
      .where("id", "=", id ?? "")
      .executeTakeFirst();
    // A user-supplied search term overrides the derived query entirely (the
    // "change the DDG search" input) — search EXACTLY what they typed.
    const override = typeof req.query.q === "string" ? req.query.q.trim() : "";
    // Only image-search a REAL identified name. An unidentified item ("Unknown
    // Item") or a bare barcode number returns junk (a "?" bag, an "UNKNOWN" sign),
    // so return nothing rather than searching for it.
    const name = row?.suggested_name?.trim() ?? "";
    // Author/media extras (Laura Ingalls Wilder + "book") sharpen a weak title.
    const { author, mediaWord } = mediaSearchExtras(row?.suggested_candidates as Array<{ fields?: Record<string, unknown> }> | null);
    const extra = [author, mediaWord].filter(Boolean).join(" ") || null;
    const q = override ? override : isJunkName(name) ? null : imageQuery(name, row?.suggested_manufacturer ?? null, extra);
    if (!q) {
      res.json({ items: [] });
      return;
    }
    // Rank a LARGER pool by catalog quality (retail/brand domain + square-ish),
    // then return the best — so the clean studio shot is at the front instead of
    // the recipe-blog / social photo DDG happened to put first.
    const pool = await searchImages(q, 24).catch(() => []);
    const items = rankImageOptions(pool, row?.suggested_manufacturer).slice(0, 12);
    res.json({ items });
  }),
);

// ─────────────────── POST /inbox/:id/catalog-image ──────────────────
// Set the item's catalog image from a picked URL (photo-options strip or
// a pasted URL). Downloads into core-files so the image survives the
// external host; the URL is SSRF-guarded inside downloadCatalogImage.

// Pick a URL (photo-options strip / pasted), REVERT to the original catalog
// image, or USE the user's own scan photo as the catalog image. The first
// override stashes the original refs in suggested_metadata.orig_catalog so a
// revert can restore them (server-side → survives reload, unlike a client ref).
const CatalogImageBody = z.union([
  z.object({ url: z.string().url().max(2000) }),
  z.object({ action: z.enum(["revert", "use_own_photo"]) }),
  // "Take a nice picture" — a freshly-captured upload becomes the DISPLAY
  // (catalog) image; the identify photo is untouched (photo roles).
  z.object({ file_id: z.string().uuid() }),
]);

interface OrigCatalog {
  url: string | null;
  file_id: string | null;
}

inboxRouter.post(
  "/inbox/:id/catalog-image",
  asyncHandler(async (req, res) => {
    if (!requireRole(req, res, "owner", "admin", "member")) return;
    const id = req.params.id;
    const parsed = CatalogImageBody.safeParse(req.body);
    if (!parsed.success) return badBody(res, parsed.error);
    const db = tenantDb(req);
    const ctx = tenantContext(req);
    const token = bearer(req);
    if (!token) {
      res.status(401).json({ error: { code: "no_auth", message: "Bearer token required" } });
      return;
    }
    const row = await db
      .selectFrom("core_scan_inbox_items")
      .select([
        "id",
        "barcode_text",
        "catalog_image_url",
        "catalog_image_file_id",
        "image_file_id",
        "suggested_metadata",
      ])
      .where("id", "=", id ?? "")
      .executeTakeFirst();
    if (!row) {
      res.status(404).json({ error: { code: "not_found", message: "inbox item not found" } });
      return;
    }
    const baseMeta = (row.suggested_metadata ?? {}) as Record<string, unknown> & { orig_catalog?: OrigCatalog };
    // Capture the original ONCE — on the first override — so Revert can restore it.
    const metaWithOrig = baseMeta.orig_catalog
      ? baseMeta
      : { ...baseMeta, orig_catalog: { url: row.catalog_image_url, file_id: row.catalog_image_file_id } };
    const fresh = () =>
      db.selectFrom("core_scan_inbox_items").selectAll().where("id", "=", row.id).executeTakeFirstOrThrow();

    if ("action" in parsed.data && parsed.data.action === "revert") {
      const orig = (baseMeta.orig_catalog ?? { url: null, file_id: null }) as OrigCatalog;
      // Reverting to the auto image relinquishes the user's pick → also clear the
      // `catalog_image_user_set` lock so a future re-identify can refresh it again.
      const { orig_catalog: _drop, catalog_image_user_set: _u, ...rest } = baseMeta as Record<string, unknown> & {
        catalog_image_user_set?: boolean;
      };
      void _drop;
      void _u;
      await db
        .updateTable("core_scan_inbox_items")
        .set({
          catalog_image_url: orig.url,
          catalog_image_file_id: orig.file_id,
          suggested_metadata: sql`${JSON.stringify(rest)}::jsonb` as never,
          updated_at: new Date(),
        })
        .where("id", "=", row.id)
        .execute();
      res.json(await fresh());
      return;
    }

    if ("action" in parsed.data && parsed.data.action === "use_own_photo") {
      if (!row.image_file_id) {
        res.status(400).json({ error: { code: "no_photo", message: "This item has no photo of yours to use." } });
        return;
      }
      await db
        .updateTable("core_scan_inbox_items")
        .set({
          catalog_image_file_id: row.image_file_id,
          catalog_image_url: null,
          // The user chose this image → lock it so a later re-identify won't clobber it.
          suggested_metadata: sql`${JSON.stringify({ ...metaWithOrig, catalog_image_user_set: true })}::jsonb` as never,
          updated_at: new Date(),
        })
        .where("id", "=", row.id)
        .execute();
      res.json(await fresh());
      return;
    }

    // A freshly-captured upload → the display/catalog image (retake-for-catalog).
    if ("file_id" in parsed.data) {
      await db
        .updateTable("core_scan_inbox_items")
        .set({
          catalog_image_file_id: parsed.data.file_id,
          catalog_image_url: null,
          // The user chose this image → lock it so a re-identify won't clobber it.
          suggested_metadata: sql`${JSON.stringify({ ...metaWithOrig, catalog_image_user_set: true })}::jsonb` as never,
          updated_at: new Date(),
        })
        .where("id", "=", row.id)
        .execute();
      res.json(await fresh());
      return;
    }

    // A picked/pasted URL: stash the original, set + download it.
    const url = (parsed.data as { url: string }).url;
    await db
      .updateTable("core_scan_inbox_items")
      .set({
        catalog_image_url: url,
        // The user chose this image → lock it so a later re-identify won't clobber it.
        suggested_metadata: sql`${JSON.stringify({ ...metaWithOrig, catalog_image_user_set: true })}::jsonb` as never,
        updated_at: new Date(),
      })
      .where("id", "=", row.id)
      .execute();
    await downloadCatalogImage({ db, orgSlug: ctx.org.slug, bearer: token, itemId: row.id }, url);
    // Picking a better catalog photo for a BARCODE item is the truth — feed it
    // back to the shared Barcode Intelligence DB as an image_url correction, so
    // the next scan of this UPC (any workspace) gets YOUR clean image, beating
    // whatever Open Food Facts / a provider had (or filling a missing image).
    if (row.barcode_text) {
      void reportBarcodeCorrection({
        upc: row.barcode_text,
        field: "image_url",
        was: row.catalog_image_url,
        now: url,
        userId: sessionUser(req).id,
      });
    }
    res.json(await fresh());
  }),
);

// ─────────────────── GET /inbox/:id/tracked-matches ─────────────────
// "Already tracked?" — entities the workspace ALREADY has that match this
// scan, by exact barcode (metadata.barcode, stamped by every confirm) or by
// name-token overlap. Powers the heads-up banner + attach targets.
inboxRouter.get(
  "/inbox/:id/tracked-matches",
  asyncHandler(async (req, res) => {
    if (!requireRole(req, res, "owner", "admin", "member")) return;
    const id = req.params.id;
    const db = tenantDb(req);
    const ctx = tenantContext(req);
    const row = await db
      .selectFrom("core_scan_inbox_items")
      .select(["barcode_text", "suggested_name", "status", "target_entity_id"])
      .where("id", "=", id ?? "")
      .executeTakeFirst();
    if (!row) {
      res.status(404).json({ error: { code: "not_found", message: "inbox item not found" } });
      return;
    }
    const matches = await findTracked(ctx.org.id, {
      barcode: row.barcode_text,
      name: row.suggested_name,
    });
    res.json(matches);
  }),
);

// ─────────────────────── POST /inbox/:id/unconfirm ─────────────────────
// REVERT a commit: bring a resolved scan back to the pending inbox so a wrong
// confirm can be redone (the mirror of restore-from-discarded, for the other
// resolution). Two cases, split on how the row resolved:
//   - CONFIRMED (an entity was CREATED from this scan): the created entity is
//     deleted through its kind's registered writer — module validation +
//     events fire — and the row reopens. If the entity is already gone (user
//     deleted it by hand) or the kind has no writer, the row still reopens
//     and the response says what was left behind.
//   - ATTACHED (this scan updated a PRE-EXISTING entity — add-qty/link/move):
//     the entity is NEVER deleted; the row reopens and the response notes any
//     quantity bump is yours to undo.

inboxRouter.post(
  "/inbox/:id/unconfirm",
  asyncHandler(async (req, res) => {
    if (!requireRole(req, res, "owner", "admin", "member")) return;
    const ctx = tenantContext(req);
    const db = tenantDb(req);
    const id = String(req.params.id);
    const row = await db
      .selectFrom("core_scan_inbox_items")
      .selectAll()
      .where("id", "=", id)
      .executeTakeFirst();
    if (!row) {
      res.status(404).json({ error: { code: "not_found", message: "inbox item not found" } });
      return;
    }
    if (row.status !== "resolved") {
      res.status(422).json({
        error: { code: "not_resolved", message: "Only a committed scan can be sent back." },
      });
      return;
    }

    const meta = (row.suggested_metadata ?? {}) as Record<string, unknown>;
    const attached = meta.attached_to as { kind?: string; id?: string; mode?: string } | undefined;
    let entityDeleted = false;
    let note: string | null = null;

    if (attached?.id) {
      note =
        attached.mode === "add-qty"
          ? "The existing entry it attached to was left untouched — undo the quantity bump there if needed."
          : "The existing entry it attached to was left untouched.";
    } else if (row.target_entity_id && row.target_module && row.target_kind) {
      const kindKey = row.target_kind.includes(":")
        ? row.target_kind
        : `${row.target_module}:${row.target_kind}`;
      const existing = await platform()
        .entities.lookup(ctx.org.id, kindKey, row.target_entity_id)
        .catch(() => null);
      if (!existing) {
        note = "The created entry was already deleted.";
      } else {
        const writer = platform().entities.getWriter(kindKey);
        if (!writer?.delete) {
          note = `The created entry couldn't be removed automatically — delete it from its own page (${existing.title}).`;
        } else {
          try {
            await writer.delete(ctx.org.id, row.target_entity_id);
            entityDeleted = true;
          } catch (err) {
            note = `The created entry couldn't be removed (${(err as Error).message}) — delete it from its own page.`;
          }
        }
      }
    }

    // Reopen: back to pending, resolution cleared, RESTORED to its original
    // spot — un-confirm is an UNDO, not a re-scan. created_at stays (it's when
    // the item was scanned, immutable history); rewriting it to now() dragged
    // the item's whole SESSION header time + sort position forward to the undo
    // moment (the session reads max(created_at) across its items). Only
    // updated_at moves. suggested_* stays — the point is to FIX + redo.
    const { attached_to: _drop, ...restMeta } = meta;
    const reopened = await db
      .updateTable("core_scan_inbox_items")
      .set({
        status: "pending",
        target_module: null,
        target_kind: null,
        target_entity_id: null,
        resolved_at: null,
        suggested_metadata: JSON.stringify(restMeta) as never,
        updated_at: new Date(),
      })
      .where("id", "=", id)
      .returningAll()
      .executeTakeFirstOrThrow();
    await appendScanHistory(db, id, {
      action: "unconfirm",
      note: entityDeleted ? "commit reverted; created entry removed" : (note ?? "commit reverted"),
    });
    void platform().events.emit("core-scan.scan.unconfirmed", {
      orgId: ctx.org.id,
      itemId: id,
      entityDeleted,
    });
    res.json({ item: reopened, entity_deleted: entityDeleted, note });
  }),
);

// ─────────────────────── POST /inbox/:id/attach ─────────────────────
// Attach this scan to an entity the workspace ALREADY tracks, instead of
// creating a duplicate. Three modes (scan-parity-final-mile.md, Epic A):
//   add-qty      — "+N, more of the same": bump the kind's qty field by the
//                  item's quantity; append the scanned barcode when the entity
//                  lacks one; attach the item's photo when the entity has none.
//   link-barcode — write metadata.barcode only (teach an existing entity its
//                  barcode; the next scan matches instantly).
//   move         — set the entity's location_id (move mode's unit action).
// All writes go through the module's OWN HTTP endpoint under the caller's
// bearer (same inherited-capability pattern as confirm) — never raw SQL into
// another module's table. The inbox item resolves as "attached".
const AttachBody = z.object({
  kind: z.string().min(1),
  entity_id: z.string().min(1),
  /** Instance slug when the entity lives in a skinned instance (the bare
   *  module route filters to the default instance and would 404). */
  instance: z.string().optional(),
  mode: z.enum(["add-qty", "link-barcode", "move"]),
  /** For mode=move: target location; defaults to the item's own
   *  target_location_id (the active bin it was scanned into). */
  location_id: z.string().optional(),
});

inboxRouter.post(
  "/inbox/:id/attach",
  asyncHandler(async (req, res) => {
    if (!requireRole(req, res, "owner", "admin", "member")) return;
    const id = req.params.id;
    const parsed = AttachBody.safeParse(req.body);
    if (!parsed.success) return badBody(res, parsed.error);
    const db = tenantDb(req);
    const ctx = tenantContext(req);
    const token = bearer(req);
    if (!token) {
      res.status(401).json({ error: { code: "no_auth", message: "Bearer token required" } });
      return;
    }
    const row = await db
      .selectFrom("core_scan_inbox_items")
      .selectAll()
      .where("id", "=", id ?? "")
      .executeTakeFirst();
    if (!row) {
      res.status(404).json({ error: { code: "not_found", message: "inbox item not found" } });
      return;
    }
    // Only a PENDING item can attach: a resolved item was already committed or
    // attached — attaching again would double-count its quantity (found by the
    // golden e2e: confirm(1) + attach(+2) on the same dedup-bumped row → 3).
    if (row.status !== "pending") {
      res.status(409).json({
        error: { code: "already_resolved", message: "this item was already committed or attached" },
      });
      return;
    }
    const scannable = platform().entities.getScannable(parsed.data.kind);
    if (!scannable) {
      res.status(400).json({
        error: { code: "not_scannable", message: `${parsed.data.kind} is not a scan target` },
      });
      return;
    }
    const baseUrl = (req.headers["x-cobblr-base-url"] as string | undefined) ?? INTERNAL_API;
    // The entity's CRUD path: instance items live under /instances/:slug/items,
    // everything else under the module's own route (same rule confirm uses).
    const entityPath = parsed.data.instance
      ? `${baseUrl}/api/v1/orgs/${ctx.org.slug}/instances/${parsed.data.instance}/items/${parsed.data.entity_id}`
      : `${baseUrl}/api/v1/orgs/${ctx.org.slug}/modules/${scannable.createEndpoint}/${parsed.data.entity_id}`;
    const authHeaders = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };

    // Read the CURRENT entity through its own module (authoritative + fresh —
    // qty for the bump, metadata for the barcode merge, location for undo).
    const getRes = await fetch(entityPath, { headers: authHeaders });
    if (!getRes.ok) {
      res.status(getRes.status === 404 ? 404 : 502).json({
        error: { code: "entity_unreachable", message: `Target entity read returned ${getRes.status}` },
      });
      return;
    }
    const entity = (await getRes.json()) as Record<string, unknown>;
    const entityName = typeof entity.name === "string" ? entity.name : parsed.data.entity_id;
    const entityMeta = (entity.metadata ?? {}) as Record<string, unknown>;
    const prevLocationId = typeof entity.location_id === "string" ? entity.location_id : null;

    const patch: Record<string, unknown> = {};
    let newQty: number | null = null;
    if (parsed.data.mode === "add-qty") {
      const cur = Number(entity[scannable.qtyField] ?? 0);
      const add = Math.max(1, Number(row.quantity ?? 1));
      newQty = (Number.isFinite(cur) ? cur : 0) + add;
      patch[scannable.qtyField] = newQty;
      // Barcode-append: a scanned (not AI-read) code the entity doesn't have yet.
      const aiRead =
        (row.suggested_metadata as { barcode_source?: string } | null)?.barcode_source === "ai-photo";
      if (row.barcode_text && !aiRead && !entityMeta.barcode) {
        patch.metadata = { ...entityMeta, barcode: row.barcode_text };
      }
    } else if (parsed.data.mode === "link-barcode") {
      if (!row.barcode_text) {
        res.status(400).json({ error: { code: "no_barcode", message: "this item has no barcode to link" } });
        return;
      }
      patch.metadata = { ...entityMeta, barcode: row.barcode_text };
      // Linking a barcode while an active bin is set ALSO files
      // the entity into that bin — the scan meant "this thing, into here".
      const linkLoc = parsed.data.location_id ?? row.target_location_id;
      if (linkLoc) patch.location_id = linkLoc;
    } else {
      const loc = parsed.data.location_id ?? row.target_location_id;
      if (!loc) {
        res.status(400).json({
          error: { code: "no_location", message: "no target location — set an active bin or pass location_id" },
        });
        return;
      }
      patch.location_id = loc;
    }

    const patchRes = await fetch(entityPath, {
      method: "PATCH",
      headers: authHeaders,
      body: JSON.stringify(patch),
    });
    if (!patchRes.ok) {
      const errText = await patchRes.text();
      let targetMsg: string | undefined;
      try {
        targetMsg = (JSON.parse(errText) as { error?: { message?: string } }).error?.message;
      } catch {
        /* non-JSON */
      }
      res.status(patchRes.status).json({
        error: { code: "attach_failed", message: targetMsg ?? `Target update returned ${patchRes.status}`, details: errText },
      });
      return;
    }

    // add-qty: give the entity the scan's photo when it has none (best-effort).
    if (parsed.data.mode === "add-qty" && !entity.image_path) {
      const photoId = row.catalog_image_file_id ?? row.image_file_id;
      if (photoId) {
        const [module] = parsed.data.kind.split(":");
        void fetch(`${baseUrl}/api/v1/orgs/${ctx.org.slug}/modules/core-files/attachments`, {
          method: "POST",
          headers: authHeaders,
          body: JSON.stringify({
            file_id: photoId,
            source_module: module,
            source_type: parsed.data.kind,
            source_id: parsed.data.entity_id,
            role: "gallery",
          }),
        })
          .then(() =>
            fetch(entityPath, {
              method: "PATCH",
              headers: authHeaders,
              body: JSON.stringify({
                image_path: `/api/v1/orgs/${ctx.org.slug}/modules/core-files/files/${photoId}/raw`,
              }),
            }),
          )
          .catch((err) => console.error("[core-scan] attach photo failed:", (err as Error).message));
      }
    }

    // Resolve the inbox item as "attached" (history + metadata carry the ref).
    const meta = (row.suggested_metadata ?? {}) as Record<string, unknown>;
    const [module] = parsed.data.kind.split(":");
    const resolvedRow = await db
      .updateTable("core_scan_inbox_items")
      .set({
        status: "resolved",
        target_module: module ?? null,
        target_kind: parsed.data.kind,
        target_entity_id: parsed.data.entity_id,
        suggested_metadata: JSON.stringify({
          ...meta,
          attached_to: { kind: parsed.data.kind, id: parsed.data.entity_id, mode: parsed.data.mode },
        }) as never,
        resolved_at: new Date(),
        updated_at: new Date(),
      })
      .where("id", "=", id ?? "")
      .returningAll()
      .executeTakeFirstOrThrow();
    await appendScanHistory(db, id ?? "", {
      action: "attached",
      note: `${parsed.data.mode} → ${entityName}`,
    });
    void platform().events.emit("core-scan.scan.attached", {
      orgId: ctx.org.id,
      itemId: id,
      targetKind: parsed.data.kind,
      entityId: parsed.data.entity_id,
      mode: parsed.data.mode,
    });

    res.json({
      item: resolvedRow,
      entity_title: entityName,
      new_qty: newQty,
      prev_location_id: prevLocationId,
    });
  }),
);

// ─────────────────── GET /bin/:locationId/contents ──────────────────
// What lives in this bin, across the scannable kinds. `single: true` = the
// bin holds exactly ONE SKU (a bin of M3 screws with only the bin labeled) —
// the scanner then offers direct qty adjust instead of the filing flow.
inboxRouter.get(
  "/bin/:locationId/contents",
  asyncHandler(async (req, res) => {
    if (!requireRole(req, res, "owner", "admin", "member")) return;
    const ctx = tenantContext(req);
    res.json(await findBinContents(ctx.org.id, req.params.locationId ?? ""));
  }),
);

// ─────────────────── POST /bin/:locationId/adjust ───────────────────
// "Adding 10 of this item / removing 5" — adjust the SKU that lives in this
// bin, straight from its QR label. Bin-scoped by construction: the entity must
// still CALL this bin home (409 if it moved since the contents read). The
// write goes through the module's OWN endpoint under the caller's bearer, the
// same inherited-capability pattern confirm/attach use. Clamped at zero.
const BinAdjustBody = z.object({
  kind: z.string().min(1),
  entity_id: z.string().min(1),
  instance: z.string().optional(),
  /** Signed change (+10 / −5) … */
  delta: z.number().int().min(-100_000).max(100_000).optional(),
  /** … or an absolute recount. Exactly one of delta/set. */
  set: z.number().int().min(0).max(1_000_000).optional(),
});
inboxRouter.post(
  "/bin/:locationId/adjust",
  asyncHandler(async (req, res) => {
    if (!requireRole(req, res, "owner", "admin", "member")) return;
    const parsed = BinAdjustBody.safeParse(req.body);
    if (!parsed.success) return badBody(res, parsed.error);
    if ((parsed.data.delta == null) === (parsed.data.set == null)) {
      res.status(400).json({ error: { code: "delta_or_set", message: "pass exactly one of delta / set" } });
      return;
    }
    const ctx = tenantContext(req);
    const token = bearer(req);
    if (!token) {
      res.status(401).json({ error: { code: "no_auth", message: "Bearer token required" } });
      return;
    }
    const scannable = platform().entities.getScannable(parsed.data.kind);
    if (!scannable) {
      res.status(400).json({ error: { code: "not_scannable", message: `${parsed.data.kind} is not a scan target` } });
      return;
    }
    const baseUrl = (req.headers["x-cobblr-base-url"] as string | undefined) ?? INTERNAL_API;
    const entityPath = parsed.data.instance
      ? `${baseUrl}/api/v1/orgs/${ctx.org.slug}/instances/${parsed.data.instance}/items/${parsed.data.entity_id}`
      : `${baseUrl}/api/v1/orgs/${ctx.org.slug}/modules/${scannable.createEndpoint}/${parsed.data.entity_id}`;
    const authHeaders = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
    const getRes = await fetch(entityPath, { headers: authHeaders });
    if (!getRes.ok) {
      res.status(getRes.status === 404 ? 404 : 502).json({
        error: { code: "entity_unreachable", message: `Entity read returned ${getRes.status}` },
      });
      return;
    }
    const entity = (await getRes.json()) as Record<string, unknown>;
    if (entity.location_id !== req.params.locationId) {
      res.status(409).json({
        error: { code: "moved", message: "This item no longer lives in that bin — rescan the label." },
      });
      return;
    }
    const cur = Number(entity[scannable.qtyField] ?? 0);
    const oldQty = Number.isFinite(cur) ? cur : 0;
    const newQty = parsed.data.set != null ? parsed.data.set : Math.max(0, oldQty + (parsed.data.delta ?? 0));
    const patchRes = await fetch(entityPath, {
      method: "PATCH",
      headers: authHeaders,
      body: JSON.stringify({ [scannable.qtyField]: newQty }),
    });
    if (!patchRes.ok) {
      const errText = await patchRes.text();
      let targetMsg: string | undefined;
      try {
        targetMsg = (JSON.parse(errText) as { error?: { message?: string } }).error?.message;
      } catch {
        /* non-JSON */
      }
      res.status(patchRes.status).json({
        error: { code: "adjust_failed", message: targetMsg ?? `Update returned ${patchRes.status}` },
      });
      return;
    }
    res.json({
      entity_title: typeof entity.name === "string" ? entity.name : parsed.data.entity_id,
      old_qty: oldQty,
      new_qty: newQty,
    });
  }),
);

// ─────────────────────── POST /inbox/:id/rotate ─────────────────────
// Rotate the item's OWN photo (a sideways phone shot). Writes a NEW file and
// swaps it in; the original is kept in metadata.extra_photos — nothing lost.
const RotateBody = z.object({ deg: z.union([z.literal(90), z.literal(180), z.literal(270)]) });
inboxRouter.post(
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
        suggested_metadata: JSON.stringify({
          ...meta,
          extra_photos: [...extras.filter((p) => p !== newId), row.image_file_id].slice(-8),
        }) as never,
        updated_at: new Date(),
      })
      .where("id", "=", id ?? "")
      .returningAll()
      .executeTakeFirstOrThrow();
    res.json(updated);
  }),
);

// ─────────────────────── /inbox/:id/photos (gallery) ────────────────
// Multi-photo per item: the primary is image_file_id; extras live in
// metadata.extra_photos (capped 8). Add / make-primary / remove.
const PhotoBody = z.object({ file_id: z.string().uuid() });
inboxRouter.post(
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
        suggested_metadata: JSON.stringify({
          ...meta,
          ...(asPrimary
            ? {}
            : { extra_photos: [...extras.filter((p) => p !== parsed.data.file_id), parsed.data.file_id].slice(-8) }),
        }) as never,
        updated_at: new Date(),
      })
      .where("id", "=", id ?? "")
      .returningAll()
      .executeTakeFirstOrThrow();
    res.json(updated);
  }),
);

inboxRouter.post(
  "/inbox/:id/photos/primary",
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
    if (!extras.includes(parsed.data.file_id)) {
      res.status(400).json({ error: { code: "not_in_gallery", message: "that photo isn't in this item's gallery" } });
      return;
    }
    const updated = await db
      .updateTable("core_scan_inbox_items")
      .set({
        image_file_id: parsed.data.file_id,
        suggested_metadata: JSON.stringify({
          ...meta,
          extra_photos: [
            ...extras.filter((p) => p !== parsed.data.file_id),
            ...(row.image_file_id ? [row.image_file_id] : []),
          ].slice(-8),
        }) as never,
        updated_at: new Date(),
      })
      .where("id", "=", id ?? "")
      .returningAll()
      .executeTakeFirstOrThrow();
    res.json(updated);
  }),
);

inboxRouter.delete(
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
        suggested_metadata: JSON.stringify({ ...meta, extra_photos: extras.filter((p) => p !== fileId) }) as never,
        updated_at: new Date(),
      })
      .where("id", "=", id ?? "")
      .returningAll()
      .executeTakeFirstOrThrow();
    res.json(updated);
  }),
);

// ─────────────────────── POST /inbox/:id/split ──────────────────────
// Split a GROUP photo (one shot of several different things) into separate
// inbox items: vision segments the photo (name + brand + qty + bounding box
// per distinct item), each region is cropped into its own photo, and each
// becomes a child item that runs the normal matchmaker. The parent resolves
// with a "split into N" note (restorable). scan-parity-final-mile.md Epic B.
inboxRouter.post(
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
    const detected = await detectSplitItems(ctx.org.id, row.image_file_id, userId);
    if (detected.length < 2) {
      res.status(409).json({
        error: {
          code: "nothing_to_split",
          message: "The AI sees one item in this photo (or couldn't segment it) — nothing to split.",
        },
      });
      return;
    }
    const children: unknown[] = [];
    for (const it of detected) {
      const cropId = await cropRegion(ctx.org.id, row.image_file_id, it.box).catch(() => null);
      const child = await db
        .insertInto("core_scan_inbox_items")
        .values({
          source_kind: "photo",
          barcode_text: null,
          source_url: null,
          image_file_id: cropId ?? row.image_file_id,
          scan_batch_id: row.scan_batch_id,
          scan_area: row.scan_area,
          target_location_id: row.target_location_id,
          created_by_user_id: userId,
          suggested_name: it.name,
          suggested_manufacturer: it.brand,
          quantity: it.qty,
          ai_confidence: "0.6",
          ai_notes: "Split from a group photo by vision — double-check the crop.",
          ai_suggested_at: new Date(),
          suggested_metadata: JSON.stringify({
            source: "vision-split",
            split_from: row.id,
          }) as never,
        } as never)
        .returningAll()
        .executeTakeFirstOrThrow();
      children.push(child);
      void platform().events.emit("core-scan.scan.received", {
        orgId: ctx.org.id,
        itemId: (child as { id: string }).id,
        barcode: null,
        sourceKind: "photo",
      });
      if (token) {
        const baseUrl = (req.headers["x-cobblr-base-url"] as string | undefined) ?? INTERNAL_API;
        void matchItem({
          orgId: ctx.org.id, userId: sessionUser(req)?.id ?? null,
          orgSlug: ctx.org.slug,
          token,
          baseUrl,
          itemId: (child as { id: string }).id,
          force: true,
        }).catch((err) => console.error("[core-scan] split-child match threw:", (err as Error).message));
      }
    }
    // Parent resolves (restorable) — its photo stays for the audit trail.
    const meta = (row.suggested_metadata ?? {}) as Record<string, unknown>;
    await db
      .updateTable("core_scan_inbox_items")
      .set({
        status: "resolved",
        suggested_metadata: JSON.stringify({
          ...meta,
          split_into: children.map((c) => (c as { id: string }).id),
        }) as never,
        ai_notes: `Split into ${children.length} items.`,
        resolved_at: new Date(),
        updated_at: new Date(),
      })
      .where("id", "=", id ?? "")
      .execute();
    await appendScanHistory(db, id ?? "", { action: "split", note: `${children.length} items` });
    res.json({ children });
  }),
);

// ──────────────────── POST /inbox/:id/confirm-barcode ────────────────
// "This listing is good — lock it in." Promote the item's CURRENT resolved
// fields (name / brand / category / catalog image) into the shared Barcode
// Intelligence DB as VERIFIED corrections (a write-token → instant override),
// so every future scan of this UPC — in any workspace — gets this clean entry
// instead of a thin crowdsourced one. Barcode items only (BIdb is UPC-keyed).
// Doesn't touch the item or commit it to inventory — that's the Confirm button.
inboxRouter.post(
  "/inbox/:id/confirm-barcode",
  asyncHandler(async (req, res) => {
    if (!requireRole(req, res, "owner", "admin", "member")) return;
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
      reportBarcodeCorrection({ upc: row.barcode_text, field: "title", was: row.suggested_name, now: row.suggested_name, userId, confirm: true }),
      reportBarcodeCorrection({ upc: row.barcode_text, field: "brand", was: row.suggested_manufacturer, now: row.suggested_manufacturer, userId, confirm: true }),
      reportBarcodeCorrection({ upc: row.barcode_text, field: "category", was: cat, now: cat, userId, confirm: true }),
      reportBarcodeCorrection({ upc: row.barcode_text, field: "image_url", was: row.catalog_image_url, now: row.catalog_image_url, userId, confirm: true }),
    ]);
    await appendScanHistory(db, id, { action: "confirm" });
    res.json(await db.selectFrom("core_scan_inbox_items").selectAll().where("id", "=", id).executeTakeFirst());
  }),
);

// ─────────────────────── POST /inbox/merge-batches ──────────────────
// Fold one scan session into another (two walk-around bursts that are really
// one job): every item in from_batch_id moves to into_batch_id, so the inbox
// shows a single session group and a ?batch review covers both.
const MergeBatchesBody = z.object({
  from_batch_id: z.string().min(1),
  into_batch_id: z.string().min(1),
});
inboxRouter.post(
  "/inbox/merge-batches",
  asyncHandler(async (req, res) => {
    if (!requireRole(req, res, "owner", "admin", "member")) return;
    const parsed = MergeBatchesBody.safeParse(req.body);
    if (!parsed.success) return badBody(res, parsed.error);
    if (parsed.data.from_batch_id === parsed.data.into_batch_id) {
      res.status(400).json({ error: { code: "same_batch", message: "those are the same session" } });
      return;
    }
    const db = tenantDb(req);
    const r = await db
      .updateTable("core_scan_inbox_items")
      .set({ scan_batch_id: parsed.data.into_batch_id, updated_at: new Date() })
      .where("scan_batch_id", "=", parsed.data.from_batch_id)
      .executeTakeFirst();
    res.json({ moved: Number(r.numUpdatedRows ?? 0) });
  }),
);

// ─────────────────────── POST /inbox/reassign-batch ─────────────────
// Move a SPECIFIC set of items into a batch. Undo path for a merge: after
// merge-batches folds session A into B, the client reassigns exactly the
// items it just moved back to A's (still-valid, now-empty) batch id. Unlike
// merge-batches this is item-scoped, not whole-batch — so folding A into B
// and then re-splitting only A's items out is precise even if B had items.
const ReassignBatchBody = z.object({
  item_ids: z.array(z.string().min(1)).min(1),
  batch_id: z.string().min(1),
});
inboxRouter.post(
  "/inbox/reassign-batch",
  asyncHandler(async (req, res) => {
    if (!requireRole(req, res, "owner", "admin", "member")) return;
    const parsed = ReassignBatchBody.safeParse(req.body);
    if (!parsed.success) return badBody(res, parsed.error);
    const db = tenantDb(req);
    const r = await db
      .updateTable("core_scan_inbox_items")
      .set({ scan_batch_id: parsed.data.batch_id, updated_at: new Date() })
      .where("id", "in", parsed.data.item_ids)
      .executeTakeFirst();
    res.json({ moved: Number(r.numUpdatedRows ?? 0) });
  }),
);

// ──────────────── POST /inbox/backfill-catalog-photos ───────────────
// Fill catalog images for pending items that have a real name but no catalog
// art (image-search by name, same as a re-identify's refresh — honors the
// user-picked-image lock). Detached per item; returns how many were queued.
inboxRouter.post(
  "/inbox/backfill-catalog-photos",
  asyncHandler(async (req, res) => {
    if (!requireRole(req, res, "owner", "admin", "member")) return;
    const db = tenantDb(req);
    const ctx = tenantContext(req);
    const rows = await db
      .selectFrom("core_scan_inbox_items")
      .select(["id", "suggested_name", "suggested_manufacturer"])
      .where("status", "in", ["pending", "enriching"])
      .where("catalog_image_url", "is", null)
      .where("catalog_image_file_id", "is", null)
      .where("suggested_name", "is not", null)
      .limit(30)
      .execute();
    const targets = rows.filter((r) => !isJunkName(r.suggested_name));
    for (const r of targets) {
      void refreshCatalogImageByName(ctx.org.id, r.id, r.suggested_name!, r.suggested_manufacturer).catch(
        (err) => console.error("[core-scan] backfill catalog photo failed:", (err as Error).message),
      );
    }
    res.json({ queued: targets.length });
  }),
);

// ──────────────────────── POST /inbox/combine ───────────────────────
// ─────────── Session theme: derive a tag + category ON THE FLY ───────────
// After a capture session, the pending items often share a theme (a mixed
// batch of related gear: some books, some accessories). One AI call over the pending
// items proposes (a) ONE cross-cutting TAG that fits them ALL regardless of
// where each lands, and (b) a CATEGORY value for the subset that are generic
// products (not titled media like books, which route to a Bookshelf). Nothing
// is hardcoded — the theme is derived; degrades to no-suggestion when AI is off.

interface ThemeItemLite {
  id: string;
  name: string | null;
  category: string | null;
  is_titled_media: boolean;
}

async function pendingThemeItems(db: ReturnType<typeof tenantDb>): Promise<ThemeItemLite[]> {
  const rows = await db
    .selectFrom("core_scan_inbox_items")
    .select(["id", "suggested_name", "suggested_metadata", "suggested_candidates"])
    .where("status", "=", "pending")
    .orderBy("created_at", "desc")
    .limit(50)
    .execute();
  const mediaField = /^(author|isbn|director|artist|composer|writer|edition|publisher|issn)$/i;
  return rows.map((r) => {
    const meta = (r.suggested_metadata ?? {}) as { category?: unknown; hint_category?: { domain?: unknown } };
    const cands = (r.suggested_candidates ?? []) as Array<{ fields?: Record<string, unknown> }>;
    const isMedia = cands.some((c) => Object.keys(c.fields ?? {}).some((k) => mediaField.test(k)));
    const cat = typeof meta.category === "string" ? meta.category : typeof meta.hint_category?.domain === "string" ? meta.hint_category.domain : null;
    return { id: r.id, name: r.suggested_name, category: cat, is_titled_media: isMedia };
  });
}

inboxRouter.get(
  "/inbox/session-theme",
  asyncHandler(async (req, res) => {
    if (!requireRole(req, res, "owner", "admin", "member")) return;
    const db = tenantDb(req);
    const ctx = tenantContext(req);
    const items = await pendingThemeItems(db);
    if (items.length < 2) {
      res.json({ tag: null, tag_item_ids: [], category: null });
      return;
    }
    const list = items.map((i, n) => `${n + 1}. ${i.name ?? "(unnamed)"}${i.category ? ` [${i.category}]` : ""}${i.is_titled_media ? " (titled media)" : ""}`).join("\n");
    const system =
      "You spot the common theme in a batch of just-scanned inventory items and propose a shared tag + an optional category. " +
      "Output ONLY one JSON object, no prose: " +
      '{"tag": "<a short 1-2 word tag that fits ALL items, Title Case, or null if they have no clear shared theme>", ' +
      '"category": "<a short product-category value for the NON-titled-media items only, or null>", ' +
      '"category_item_numbers": [<the 1-based numbers of the items the category applies to — the generic products, NEVER titled media>]}. ' +
      "Rules: the tag must genuinely fit every item or be null (don't force it). The category groups the non-media products; titled media (books) get the tag but not the category. Derive both from what you see — invent nothing generic like \"Miscellaneous\".";
    let parsed: { tag?: unknown; category?: unknown; category_item_numbers?: unknown } | null = null;
    try {
      const r = await platform().ai.invoke({
        orgId: ctx.org.id,
        capability: "chat",
        input: { messages: [{ role: "system", content: system }, { role: "user", content: `The ${items.length} pending items:\n${list}` }] },
        source: { kind: "core-scan:session-theme", id: ctx.org.id },
        userId: sessionUser(req).id,
      });
      const raw = (r.result as { content?: string; text?: string }).content ?? (r.result as { text?: string }).text ?? "";
      const m = raw.match(/\{[\s\S]*\}/);
      if (m) parsed = JSON.parse(m[0]);
    } catch {
      /* AI off / errored → no suggestion */
    }
    const tag = parsed && typeof parsed.tag === "string" && parsed.tag.trim() ? parsed.tag.trim().slice(0, 60) : null;
    const catValue = parsed && typeof parsed.category === "string" && parsed.category.trim() ? parsed.category.trim().slice(0, 80) : null;
    const catNums = Array.isArray(parsed?.category_item_numbers) ? parsed!.category_item_numbers.map((n) => Number(n)) : [];
    const catIds = catNums.map((n) => items[n - 1]?.id).filter((x): x is string => !!x);
    res.json({
      tag,
      tag_item_ids: tag ? items.map((i) => i.id) : [],
      category: catValue && catIds.length ? { value: catValue, item_ids: catIds } : null,
    });
  }),
);

// POST /inbox/apply-theme — stash the accepted theme onto the pending items:
// pending_tags (attached to the entity at confirm) + a category hint the
// confirm form pre-fills. No entity is created here.
const ApplyThemeBody = z.object({
  tag: z.string().min(1).max(60).optional(),
  tag_item_ids: z.array(z.string().uuid()).max(200).default([]),
  category: z.object({ value: z.string().min(1).max(80), item_ids: z.array(z.string().uuid()).max(200) }).optional(),
});
inboxRouter.post(
  "/inbox/apply-theme",
  asyncHandler(async (req, res) => {
    if (!requireRole(req, res, "owner", "admin", "member")) return;
    const parsed = ApplyThemeBody.safeParse(req.body);
    if (!parsed.success) return badBody(res, parsed.error);
    const db = tenantDb(req);
    const catIds = new Set(parsed.data.category?.item_ids ?? []);
    const catValue = parsed.data.category?.value;
    const touched = new Set([...(parsed.data.tag ? parsed.data.tag_item_ids : []), ...catIds]);
    let tagged = 0;
    let categorized = 0;
    for (const id of touched) {
      const row = await db.selectFrom("core_scan_inbox_items").select(["suggested_metadata"]).where("id", "=", id).where("status", "=", "pending").executeTakeFirst();
      if (!row) continue;
      const meta = ((row.suggested_metadata ?? {}) as Record<string, unknown>) ?? {};
      const overlay: Record<string, unknown> = {};
      if (parsed.data.tag && parsed.data.tag_item_ids.includes(id)) {
        const cur = Array.isArray(meta.pending_tags) ? (meta.pending_tags as string[]) : [];
        if (!cur.includes(parsed.data.tag)) { overlay.pending_tags = [...cur, parsed.data.tag]; tagged++; }
      }
      if (catValue && catIds.has(id)) { overlay.suggested_category = catValue; categorized++; }
      if (Object.keys(overlay).length === 0) continue;
      // jsonb-merge onto the LIVE row so a concurrent matchmaker write can't
      // clobber the tag/category (and we don't clobber IT).
      await db
        .updateTable("core_scan_inbox_items")
        .set({ suggested_metadata: sql`coalesce(suggested_metadata, '{}'::jsonb) || ${JSON.stringify(overlay)}::jsonb` as never, updated_at: new Date() })
        .where("id", "=", id)
        .execute();
    }
    res.json({ tagged, categorized });
  }),
);

// "These look like the same product — combine." Merge several pending items
// (you scanned 4 of one thing, but one pack carried a different barcode) into a
// SINGLE line with the summed quantity. The distinct barcodes are preserved in
// the kept item's metadata (merged_barcodes) so nothing is lost; the others are
// soft-discarded (restorable). Always user-initiated — never auto-merges across
// barcodes, since a different UPC can be a genuinely different SKU.
const CombineBody = z.object({
  ids: z.array(z.string()).min(2).max(50),
  /** Which item's name/photo to keep; defaults to the first id. */
  keep_id: z.string().optional(),
});

inboxRouter.post(
  "/inbox/combine",
  asyncHandler(async (req, res) => {
    if (!requireRole(req, res, "owner", "admin", "member")) return;
    const parsed = CombineBody.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ error: { code: "bad_request", message: "ids[] (2–50) required" } });
      return;
    }
    const db = tenantDb(req);
    const { ids, keep_id } = parsed.data;
    const rows = await db
      .selectFrom("core_scan_inbox_items")
      .selectAll()
      .where("id", "in", ids)
      .where("status", "=", "pending")
      .execute();
    if (rows.length < 2) {
      res.status(400).json({ error: { code: "too_few", message: "need ≥2 pending items to combine" } });
      return;
    }
    const primary = rows.find((r) => r.id === keep_id) ?? rows[0];
    if (!primary) {
      res.status(400).json({ error: { code: "too_few", message: "need ≥2 pending items to combine" } });
      return;
    }
    const others = rows.filter((r) => r.id !== primary.id);
    const totalQty = rows.reduce((n, r) => n + (Number(r.quantity) || 1), 0);
    const barcodes = Array.from(new Set(rows.map((r) => r.barcode_text).filter(Boolean))) as string[];
    const meta = (primary.suggested_metadata ?? {}) as Record<string, unknown>;
    // Barcode authority: if the kept item's own barcode was READ BY AI (OCR, can
    // be a digit off) — or it has none — but a merged item carries a SCANNED one,
    // adopt the scanned code as the kept item's barcode. So you keep the photo +
    // name you chose AND end up with the real barcode. Clear the ai-photo flag.
    const primaryAiBarcode = (meta as { barcode_source?: string }).barcode_source === "ai-photo";
    const scannedBarcode = others.find(
      (o) => o.barcode_text && (o.suggested_metadata as { barcode_source?: string } | null)?.barcode_source !== "ai-photo",
    )?.barcode_text;
    const adoptBarcode = (primaryAiBarcode || !primary.barcode_text) && scannedBarcode ? scannedBarcode : null;
    const { barcode_source: _bs, ...metaNoSource } = meta as { barcode_source?: string };
    // Never lose the user's real photo on a merge: if the kept item has no photo
    // of its own but a merged one does, carry it over (e.g. "keep the scanned
    // listing" still keeps the picture you took).
    const adoptPhoto = !primary.image_file_id ? others.find((o) => o.image_file_id)?.image_file_id ?? null : null;
    await db
      .updateTable("core_scan_inbox_items")
      .set({
        quantity: totalQty,
        ...(adoptBarcode ? { barcode_text: adoptBarcode } : {}),
        ...(adoptPhoto ? { image_file_id: adoptPhoto } : {}),
        suggested_metadata: JSON.stringify({
          ...(adoptBarcode ? metaNoSource : meta),
          ...(barcodes.length ? { merged_barcodes: barcodes } : {}),
          merged_count: rows.length,
        }) as never,
        updated_at: new Date(),
      })
      .where("id", "=", primary.id)
      .execute();
    await db
      .updateTable("core_scan_inbox_items")
      .set({ status: "discarded", updated_at: new Date() })
      .where(
        "id",
        "in",
        others.map((o) => o.id),
      )
      .execute();
    await appendScanHistory(db, primary.id, { action: "combine", note: `${rows.length} items` });
    res.json(await db.selectFrom("core_scan_inbox_items").selectAll().where("id", "=", primary.id).executeTakeFirst());
  }),
);

// ──────────────────── the matchmaker, server-owned ──────────────────
// Routing + field-fill runs ONCE, at intake, server-side (the author: "it should
// not require the phone or computer webapp to be open, and it should not
// re-run when a webpage connects"). The web never auto-triggers it.

/** In-flight guard: one match per item at a time, across requests/tabs.
 *  Two open tabs used to fire two ~25s model runs for the same item. */
const matchInFlight = new Map<string, number>();

interface MatchItemOpts {
  orgId: string;
  orgSlug: string;
  token: string;
  baseUrl: string;
  itemId: string;
  /** Scanning user (null for a background/cron match) — routes AI to their
   *  personal connection. */
  userId?: string | null;
  /** true = explicit re-rank (rerun / POST /match); false = intake
   *  auto-match, which SKIPS items already matched (matched_at stamp). */
  force: boolean;
}

/** For a book candidate whose table has an ISBN field the match left BLANK, look
 *  the ISBN up from Open Library by title + author (+ publisher) and fill it. The
 *  ISBN is almost never printed on a cover, so vision can't read it — a title
 *  lookup backfills it authoritatively (preferring the edition whose publisher
 *  matches the item's brand). Best-effort, never throws; only BACKFILLS (never
 *  overrides an ISBN the match already produced); writes back only on a change. */
async function backfillBookIsbn(
  orgId: string,
  itemId: string,
  candidates: MatchCandidate[],
  menu: ScanMenuEntry[],
  title: string,
  brand: string | null,
): Promise<void> {
  try {
    const byKey = new Map(menu.map((m) => [`${m.module}::${m.instance ?? ""}`, m]));
    let changed = false;
    for (const c of candidates) {
      const entry = byKey.get(`${c.module}::${c.instance ?? ""}`);
      const isbnField = entry?.fields.find((f) => /^isbn$/i.test(f.name));
      if (!isbnField) continue; // table has no ISBN field → not a book table
      const cur = c.fields[isbnField.name];
      if (cur != null && String(cur).replace(/[^0-9Xx]/g, "").length >= 10) continue; // already has one
      const author = (Object.entries(c.fields).find(([k]) => /^author$/i.test(k))?.[1] as string | undefined) ?? null;
      const isbn = await lookupBookIsbn(c.name || title, author, brand);
      if (isbn) {
        c.fields[isbnField.name] = isbn;
        changed = true;
      }
    }
    if (!changed) return;
    const db = (await platform().tenants.getDb(orgId)) as unknown as ReturnType<typeof tenantDb>;
    await db
      .updateTable("core_scan_inbox_items")
      .set({ suggested_candidates: JSON.stringify(candidates) as never, updated_at: new Date() })
      .where("id", "=", itemId)
      .where("status", "=", "pending")
      .execute();
    console.log(`[core-scan] backfilled ISBN for ${itemId} from Open Library`);
  } catch (e) {
    console.error(`[core-scan] ISBN backfill for ${itemId} failed:`, (e as Error).message);
  }
}

/** After an item matches, normalise the SECONDARY routing across every pending
 *  item of the SAME series in the SAME scan session, so a shelf of one series
 *  routes uniformly (all offer a given secondary table, or none) instead of the
 *  model's per-item coin-flip. Deterministic (no model call), idempotent, and
 *  guarded to only touch items whose candidates actually change — so running it
 *  after each item in the batch simply converges. Only fires for an item that
 *  HAS a series + a batch; a lone or series-less item is a no-op. Best-effort. */
async function reconcileSeriesRouting(orgId: string, batchId: string | null, series: string | null): Promise<void> {
  if (!batchId || !series || !series.trim()) return;
  try {
    const db = (await platform().tenants.getDb(orgId)) as unknown as ReturnType<typeof tenantDb>;
    const rows = await db
      .selectFrom("core_scan_inbox_items")
      .select(["id", "suggested_candidates", "suggested_metadata"])
      .where("scan_batch_id", "=", batchId)
      .where("status", "=", "pending")
      .execute();
    const want = series.trim().toLowerCase();
    const group = rows
      .filter((r) => {
        const s = (r.suggested_metadata as { series?: unknown } | null)?.series;
        return typeof s === "string" && s.trim().toLowerCase() === want;
      })
      .map((r) => ({ id: r.id, candidates: (r.suggested_candidates ?? []) as MatchCandidate[] }));
    if (group.length < 2) return;
    const changes = reconcileSeriesSecondaries(group);
    for (const [id, cands] of changes) {
      await db
        .updateTable("core_scan_inbox_items")
        .set({ suggested_candidates: JSON.stringify(cands) as never, updated_at: new Date() })
        .where("id", "=", id)
        .where("status", "=", "pending")
        .execute();
    }
    if (changes.size > 0) {
      console.log(`[core-scan] series-reconciled ${changes.size}/${group.length} "${series}" items in batch ${batchId}`);
    }
  } catch (e) {
    console.error(`[core-scan] series reconcile (batch ${batchId}) failed:`, (e as Error).message);
  }
}

/** Run vision corroboration + the matchmaker for one item and persist the
 *  result (+ a matched_at stamp so intake auto-match never repeats). Returns
 *  the candidates, or null when skipped (no row / nothing identified yet /
 *  already matched / another match in flight). */
async function matchItem(opts: MatchItemOpts): Promise<unknown[] | null> {
  const inflight = matchInFlight.get(opts.itemId);
  if (inflight && Date.now() - inflight < 120_000) return null;
  matchInFlight.set(opts.itemId, Date.now());
  try {
    // Acquire a LIVE pool — this runs detached minutes after the request
    // that scheduled it, past the idle reaper (see the /scan read-back note).
    const db = (await platform().tenants.getDb(opts.orgId)) as unknown as ReturnType<typeof tenantDb>;
    const row = await db
      .selectFrom("core_scan_inbox_items")
      .selectAll()
      .where("id", "=", opts.itemId)
      .executeTakeFirst();
    if (!row) return null;
    if (!row.suggested_name && !row.barcode_text) return null;
    const meta = (row.suggested_metadata ?? {}) as {
      category?: string;
      entity_type?: "asset" | "part";
      description?: string;
      photo_observations?: string;
      matched_at?: string;
    };
    if (!opts.force && meta.matched_at) return null;

    // Vision corroboration: when the scan carries the user's own photo,
    // a factual read of it ("one loose skein in hand", "sealed 10-pack,
    // label says QTY 10") joins the matchmaker context and OUTRANKS
    // listing-derived counts — this catches the unit-barcode-on-a-9-pack-
    // listing trap. Cached in suggested_metadata so re-matches don't
    // re-pay the vision call. Best-effort with a hang guard.
    let photoObservations = meta.photo_observations ?? null;
    if (!photoObservations && row.image_file_id) {
      photoObservations = await Promise.race([
        observeScanPhoto(opts.orgId, row.image_file_id, opts.itemId, opts.userId),
        new Promise<null>((resolve) => setTimeout(() => resolve(null), 15_000)),
      ]);
    }

    const menu = await assembleMergedMenu(opts.baseUrl, opts.orgSlug, opts.token);
    const candidates = await runMatchmaker(
      opts.orgId,
      {
        name: row.suggested_name ?? "",
        manufacturer: row.suggested_manufacturer,
        category: meta.category ?? null,
        description: meta.description ?? null,
        entityType: meta.entity_type ?? null,
        barcode: row.barcode_text,
        sku: row.suggested_sku,
        notes: row.ai_notes,
        scanArea: row.scan_area,
        // The full lookup metadata — pack sizes, weights, colours the
        // catalog/web search surfaced.
        metadata: row.suggested_metadata ?? null,
        photoObservations,
      },
      menu,
      opts.itemId, // links the AI-log row to this scan
      opts.userId,
    );

    // Persist: candidates + the matched_at stamp (the web renders a passive
    // "AI is reading…" pulse until this lands — no client triggering) +
    // the cached photo observations. The top candidate's reconciliation
    // replaces the provenance one-liner in ai_notes when present.
    // RE-ACQUIRE the pool: the model call above can run for minutes (the
    // claude bridge queues), long past the idle reaper — writing on the
    // pre-call handle is the classic "pool after end" (see /scan read-back).
    const dbAfter = (await platform().tenants.getDb(opts.orgId)) as unknown as ReturnType<typeof tenantDb>;
    const top = candidates[0];
    // A barcode item a curated PROVIDER already identified keeps its "Resolved
    // via {source}" provenance + identification confidence — the matchmaker's
    // keyword-routing note ("Matched by keywords (no AI)…") must not clobber the
    // identification headline (the routing still shows via the candidate chips).
    // Photos/notes have no such provenance → the matchmaker's note IS the
    // identification, so it stands.
    const idSource = ((row.suggested_metadata ?? {}) as { source?: string }).source ?? "";
    const REAL_BARCODE_SOURCES = new Set(["go-upc", "openfoodfacts", "openproductsfacts", "upcitemdb"]);
    const barcodeIdentified = !!row.barcode_text && !!row.suggested_name && REAL_BARCODE_SOURCES.has(idSource);
    // For web-search / photo (NON-curated) items the matchmaker's candidate name
    // is the reconciled one its note describes — publisher / author-parenthetical /
    // retailer-noise stripped (a book: "Delmar Cengage Learning … (Whitman)" →
    // "Refrigeration & Air Conditioning Technology"). Adopt it as the displayed
    // name so the name and the note AGREE (the note kept claiming a cleanup the
    // header didn't reflect). Guards: only when it changed, and never DROP a
    // size/spec the resolved name carried (keep #384's "1.75 L").
    const candName =
      top && typeof top === "object" && "name" in top ? String((top as { name?: string }).name ?? "").trim() : "";
    const SPEC_RE =
      /\b\d+(?:\.\d+)?\s?(?:ml|cl|l|fl\.?\s?oz|oz|g|kg|mg|lb|ct|pk|pack|count|gal|qt|pt|proof|%)\b/i;
    const adoptName =
      !!candName &&
      !barcodeIdentified &&
      candName.toLowerCase() !== (row.suggested_name ?? "").toLowerCase() &&
      !(SPEC_RE.test(row.suggested_name ?? "") && !SPEC_RE.test(candName));
    await dbAfter
      .updateTable("core_scan_inbox_items")
      .set({
        suggested_candidates: JSON.stringify(candidates) as never,
        ...(adoptName ? { suggested_name: candName } : {}),
        // jsonb-merge ONLY the keys this match sets onto the LIVE row value —
        // never a stale in-memory snapshot. Otherwise a concurrent write (the
        // detached matchmaker races apply-theme's pending_tags, or a user_hint /
        // series stamp) is silently clobbered. `||` overlays keys DB-side.
        suggested_metadata: sql`coalesce(suggested_metadata, '{}'::jsonb) || ${JSON.stringify({
          ...(photoObservations ? { photo_observations: photoObservations } : {}),
          // Reliability net: if identify didn't STRUCTURE a serial but the model
          // named one in its reasoning/observations, promote it to the native
          // key so it reaches the item's serial_number field on commit. Only
          // when not already set (never clobber a structured read).
          ...((() => {
            const existing = (row.suggested_metadata as { serial_number?: string } | null)?.serial_number;
            if (existing) return {};
            const s = extractSerial(
              [
                top && typeof top === "object" && "notes" in top ? (top as { notes?: string }).notes ?? "" : "",
                photoObservations ?? "",
                row.ai_notes ?? "",
              ].join("\n"),
            );
            return s ? { serial_number: s } : {};
          })()),
          matched_at: new Date().toISOString(),
        })}::jsonb` as never,
        ...(top && typeof top === "object" && "notes" in top && (top as { notes?: string }).notes && !barcodeIdentified
          ? {
              ai_notes: (top as { notes: string }).notes,
              ai_confidence: String((top as { confidence: number }).confidence),
            }
          : {}),
        // Stamp the canonical "matchmaker has run" marker. Without it a note that
        // matched NOTHING (e.g. "3d printer" on a blank workspace) left the web's
        // "reading…" pulse spinning forever — the UI keys off ai_suggested_at to
        // know enrichment finished. Set once; a re-match keeps the original stamp.
        ...(row.ai_suggested_at ? {} : { ai_suggested_at: new Date() }),
        updated_at: new Date(),
      })
      .where("id", "=", opts.itemId)
      .execute();

    // "Where should this go?" — with the item identified + routed, suggest a
    // home from where its siblings already live. Only when the user hasn't
    // already set a location (a scan-session bin, or a note like "…in Bin 4").
    // Detached-safe: it's the last step and best-effort; a failure never affects
    // the match. Re-reads the row (adoptName above may have changed the name).
    try {
      if (!row.target_location_id) {
        const identified = adoptName ? candName : row.suggested_name;
        const sug = await suggestLocationForItem(opts.orgId, {
          name: identified,
          category: meta.category ?? null,
          excludeId: opts.itemId,
        });
        if (sug) {
          const dbSug = (await platform().tenants.getDb(opts.orgId)) as unknown as ReturnType<typeof tenantDb>;
          // Guard the write: skip if the user set a location while we looked.
          await dbSug
            .updateTable("core_scan_inbox_items")
            .set({
              suggested_location_id: sug.location_id,
              suggested_location_note: `${sug.location_name} — ${sug.reason}`,
              updated_at: new Date(),
            })
            .where("id", "=", opts.itemId)
            .where("target_location_id", "is", null)
            .execute();
        }
      }
    } catch (e) {
      console.error(`[core-scan] location suggestion for ${opts.itemId} failed:`, (e as Error).message);
    }
    // When the matchmaker RENAMED the item (adoptName), the stage-1 cover was
    // fetched for the OLD name and would pop in a poll or two later — reading as
    // "still working" after the card looked settled. Re-fetch the cover for the
    // final name HERE so it lands inside the finalized window, not after it.
    if (adoptName) {
      try {
        await refreshCatalogImageByName(opts.orgId, opts.itemId, candName, row.suggested_manufacturer ?? null);
      } catch (e) {
        console.error(`[core-scan] finalize image refresh for ${opts.itemId} failed:`, (e as Error).message);
      }
    }
    // Backfill a book's ISBN from Open Library when the match left it blank —
    // the ISBN isn't on the cover, so vision can't read it, but title+author can
    // look it up. Mutates `candidates` + rewrites, before finalize/reconcile.
    await backfillBookIsbn(
      opts.orgId,
      opts.itemId,
      candidates as MatchCandidate[],
      menu,
      (adoptName ? candName : row.suggested_name) ?? "",
      row.suggested_manufacturer ?? null,
    );
    // Stamp finalized_at — the canonical "nothing more will change" marker.
    // matched_at means the matchmaker RAN; finalized_at means the whole tail
    // (location + cover) is done too. The inbox UI keys its "finishing… → ready"
    // transition + the session "all set" signal off this, so a card stops
    // reading as settled while its title/genre/thumbnail are still mutating.
    try {
      const dbFin = (await platform().tenants.getDb(opts.orgId)) as unknown as ReturnType<typeof tenantDb>;
      await dbFin
        .updateTable("core_scan_inbox_items")
        .set({
          suggested_metadata:
            sql`coalesce(suggested_metadata, '{}'::jsonb) || jsonb_build_object('finalized_at', now()::text)` as never,
          updated_at: new Date(),
        })
        .where("id", "=", opts.itemId)
        .execute();
    } catch (e) {
      console.error(`[core-scan] finalize stamp for ${opts.itemId} failed:`, (e as Error).message);
    }
    // Normalise secondary routing across same-series siblings in this session so
    // the shelf routes uniformly (deterministic; #3 of the routing-consistency
    // work, on top of the tightened model prompt).
    await reconcileSeriesRouting(
      opts.orgId,
      row.scan_batch_id,
      (row.suggested_metadata as { series?: string } | null)?.series ?? null,
    );
    return candidates;
  } catch (err) {
    // The match FAILED before stamping matched_at — the menu fetch, the model
    // call, or (classically) a write on the now-stale tenant pool after the
    // model ran for minutes. Without a matched_at stamp the card spins on
    // "finding the best table…" FOREVER (serverMatching keys off its absence),
    // with no give-up. Best-effort: stamp matched_at (+ a match_failed marker) so
    // the UI stops spinning and shows the resolved name; the user can re-run or
    // route by hand. Re-acquire the pool; swallow a second failure quietly.
    console.error(`[core-scan] matchItem ${opts.itemId} failed:`, (err as Error).message);
    try {
      const dbErr = (await platform().tenants.getDb(opts.orgId)) as unknown as ReturnType<typeof tenantDb>;
      await dbErr
        .updateTable("core_scan_inbox_items")
        .set({
          // finalized_at too: a failed match is still DONE churning — the UI must
          // settle it (needs manual routing), not park it in "finishing…" forever.
          suggested_metadata:
            sql`coalesce(suggested_metadata, '{}'::jsonb) || jsonb_build_object('matched_at', now()::text, 'match_failed', true, 'finalized_at', now()::text)` as never,
          ai_suggested_at: sql`coalesce(ai_suggested_at, now())` as never,
          updated_at: new Date(),
        })
        .where("id", "=", opts.itemId)
        .execute();
    } catch (e2) {
      console.error(`[core-scan] matchItem ${opts.itemId} fail-stamp also failed:`, (e2 as Error).message);
    }
    return null;
  } finally {
    matchInFlight.delete(opts.itemId);
  }
}

/** Intake auto-match: wait (detached) for enrichment to land — the barcode
 *  race may overrun its budget, and photo items identify via the wire —
 *  then match once. Polls the row up to ~2 min; gives up silently. */
function autoMatchWhenEnriched(opts: Omit<MatchItemOpts, "force">): void {
  void (async () => {
    try {
      for (let i = 0; i < 40; i++) {
        await new Promise((r) => setTimeout(r, 3_000));
        const db = (await platform().tenants.getDb(opts.orgId)) as unknown as ReturnType<typeof tenantDb>;
        const row = await db
          .selectFrom("core_scan_inbox_items")
          .select(["suggested_name", "ai_suggested_at", "status", "suggested_metadata"])
          .where("id", "=", opts.itemId)
          .executeTakeFirst();
        if (!row || row.status !== "pending") return; // gone / triaged already
        const meta = (row.suggested_metadata ?? {}) as { matched_at?: string };
        if (meta.matched_at) return; // someone matched it (rerun, explicit)
        if (row.suggested_name || row.ai_suggested_at) {
          await matchItem({ ...opts, force: false });
          return;
        }
      }
    } catch (err) {
      console.error("[core-scan] intake auto-match failed:", (err as Error).message);
    }
  })();
}

// ──────────────────────── POST /inbox/:id/match ─────────────────────
// Explicit re-rank (the web's rerun flow, scripts). Intake no longer
// depends on this being called.
inboxRouter.post(
  "/inbox/:id/match",
  asyncHandler(async (req, res) => {
    if (!requireRole(req, res, "owner", "admin", "member")) return;
    const ctx = tenantContext(req);
    const token = bearer(req);
    const id = req.params.id;
    if (!id) {
      res.status(400).json({ error: { code: "missing_id", message: "missing id" } });
      return;
    }
    if (!token) {
      res.status(401).json({ error: { code: "unauthenticated", message: "missing bearer" } });
      return;
    }
    const baseUrl = (req.headers["x-cobblr-base-url"] as string | undefined) ?? INTERNAL_API;
    const candidates = await matchItem({
      orgId: ctx.org.id, userId: sessionUser(req)?.id ?? null,
      orgSlug: ctx.org.slug,
      token,
      baseUrl,
      itemId: id,
      force: true,
    });
    res.json({ candidates: candidates ?? [] });
  }),
);

// ──────────────────────── POST /batches ────────────────────────────

inboxRouter.post(
  "/batches",
  asyncHandler(async (req, res) => {
    if (!requireRole(req, res, "owner", "admin", "member")) return;
    const db = tenantDb(req);
    const session = sessionUser(req);
    const row = await db
      .insertInto("core_scan_batches")
      .values({ created_by_user_id: session.id })
      .returningAll()
      .executeTakeFirstOrThrow();
    res.status(201).json(row);
  }),
);

// ──────────────────────── GET /menu ─────────────────────────────────
// The workspace "scan menu" — every routable table (enabled instances,
// incl. each module's default) with its field defs. The SAME menu the
// matchmaker prompts with, exposed so the UI's target picker reflects
// the workspace's actual tables ("Yarn", not a hardcoded
// inventory/assets/machines list the web has no business knowing).

inboxRouter.get(
  "/menu",
  asyncHandler(async (req, res) => {
    if (!requireRole(req, res, "owner", "admin", "member")) return;
    const token = bearer(req);
    if (!token) {
      res.status(401).json({ error: { code: "unauthenticated", message: "missing bearer" } });
      return;
    }
    const ctx = tenantContext(req);
    const baseUrl = (req.headers["x-cobblr-base-url"] as string | undefined) ?? INTERNAL_API;
    const items = await assembleScanMenu(baseUrl, ctx.org.slug, token);
    res.json({ items });
  }),
);
