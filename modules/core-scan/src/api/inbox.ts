// /api/v1/orgs/:slug/modules/core-scan
//
// v0.1 routes:
//   POST /scan                  — ingest a barcode (photos = v0.2).
//                                  Inline-enriches up to a 12s budget.
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

import { Router } from "express";
import { z } from "zod";
import { platform } from "@cobblr/platform-contract";
import { bearer, sessionUser, tenantContext, tenantDb } from "../db.js";
import { asyncHandler, badBody, requireRole } from "./util.js";
import { downloadCatalogImage, enrichBarcodeItem } from "../services/enrich.js";
import { enrichPhotoItem, observeScanPhoto } from "../services/enrich-photo.js";
import { searchImages } from "../services/ddg-images.js";
import { assembleScanMenu, runMatchmaker } from "../services/matchmaker.js";

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

// ─────────────────────────── POST /scan ────────────────────────────

const ScanBody = z.object({
  barcode: z.string().min(4).max(64).optional(),
  source_kind: z.enum(["barcode", "photo", "url", "receipt"]).default("barcode"),
  source_url: z.string().url().max(2000).optional(),
  image_file_id: z.string().uuid().optional(),
  scan_batch_id: z.string().uuid().optional(),
  scan_area: z.string().max(200).optional(),
  /** Per-scan budget for the inline enrichment race. After this
   *  the response returns the bare row and enrichment continues
   *  detached. Default 12s mirrors companion app. */
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

    const inserted = await db
      .insertInto("core_scan_inbox_items")
      .values({
        source_kind: body.source_kind,
        barcode_text: body.barcode ?? null,
        source_url: body.source_url ?? null,
        image_file_id: body.image_file_id ?? null,
        scan_batch_id: body.scan_batch_id ?? null,
        scan_area: scanArea,
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

// ─────────────────────────── GET /inbox ────────────────────────────

const ListQuery = z.object({
  status: z.enum(["pending", "enriching", "resolved", "discarded"]).optional(),
  source_kind: z.enum(["barcode", "photo", "url", "receipt"]).optional(),
  batch_id: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
});

inboxRouter.get(
  "/inbox",
  asyncHandler(async (req, res) => {
    const q = ListQuery.safeParse(req.query);
    if (!q.success) return badBody(res, q.error);
    const db = tenantDb(req);
    let query = db
      .selectFrom("core_scan_inbox_items")
      .selectAll()
      .orderBy("created_at", "desc")
      .limit(q.data.limit);
    // Default scope: hide discarded items in the standard list.
    if (q.data.status) {
      query = query.where("status", "=", q.data.status);
    } else {
      query = query.where("status", "!=", "discarded");
    }
    if (q.data.source_kind) query = query.where("source_kind", "=", q.data.source_kind);
    if (q.data.batch_id) query = query.where("scan_batch_id", "=", q.data.batch_id);
    const items = await query.execute();
    res.json({ items });
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
    const db = tenantDb(req);
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

const KIND_CREATE_ENDPOINTS: Record<string, string> = {
  "inventory:part": "inventory/parts",
  "machines:machine": "machines/machines",
  "assets:asset": "assets/assets",
};

// Each target kind names its quantity field differently — map the inbox
// row's quantity onto the right one so a commit carries the count.
const KIND_QTY_FIELD: Record<string, string> = {
  "inventory:part": "qty",
  "assets:asset": "quantity",
  "machines:machine": "quantity",
};

/** Route a draft to its target kind: an explicit choice wins; otherwise
 *  the identify's asset/part hint (asset → assets:asset, else the safe
 *  inventory:part default). */
function resolveTargetKind(
  explicitModule: string | undefined,
  explicitKind: string | undefined,
  entityType: unknown,
): { module: string; kind: string } {
  if (explicitModule && explicitKind) return { module: explicitModule, kind: explicitKind };
  if (entityType === "asset") return { module: "assets", kind: "asset" };
  return { module: "inventory", kind: "part" };
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
    const createPath = KIND_CREATE_ENDPOINTS[kindKey];
    if (!createPath) {
      res.status(400).json({
        error: {
          code: "unknown_target_kind",
          message: `No create endpoint registered for ${kindKey}. Today: inventory:part, machines:machine, assets:asset.`,
        },
      });
      return;
    }

    // Build the create body. Defaults from the suggestion + extras win.
    // The quantity rides on the kind's own field name (qty vs quantity).
    const qty = parsed.data.quantity ?? Number(row.quantity ?? 1);
    const qtyField = KIND_QTY_FIELD[kindKey];
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
      // Carry the SKU + barcode + source into metadata so a future
      // catalog-match step can find this entity.
      metadata: {
        barcode: row.barcode_text ?? undefined,
        sku: row.suggested_sku ?? undefined,
        category: (meta as { category?: string }).category ?? undefined,
        scan_source: (meta as { source?: string }).source ?? undefined,
        // Fields a scan-URL resolver seeded (e.g. a Polar spool's size /
        // batch_code). Generic: the kernel doesn't know the vendor — it
        // just carries whatever `fields` the resolver stamped. Matchmaker
        // candidate + user-typed values still win per-key below.
        ...((meta as { fields?: Record<string, unknown> }).fields ?? {}),
        ...candidateFields,
        ...typedMetadata,
      },
      ...(qtyField && qty ? { [qtyField]: qty } : {}),
      ...(parsed.data.location_id ? { location_id: parsed.data.location_id } : {}),
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
    const createRes = await fetch(createUrl, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
    if (!createRes.ok) {
      const errText = await createRes.text();
      res.status(createRes.status).json({
        error: {
          code: "create_failed",
          message: `Target create returned ${createRes.status}`,
          details: errText,
        },
      });
      return;
    }
    const created = (await createRes.json()) as { id: string };

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
        // Optionally also point image_path at the catalog photo. An
        // instance-scoped entity is invisible to the bare module route
        // (its CRUD filters to the default instance), so the patch must
        // ride the same instance path the create used.
        const patchUrl = parsed.data.instance
          ? `${baseUrl}/api/v1/orgs/${ctx.org.slug}/instances/${parsed.data.instance}/items/${created.id}`
          : `${baseUrl}/api/v1/orgs/${ctx.org.slug}/modules/${createPath}/${created.id}`;
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
    if (parsed.data.save_eval_case && sess.is_platform_admin) {
      try {
        const menu = await assembleScanMenu(baseUrl, ctx.org.slug, token);
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

// ─────────────────────── POST /inbox/:id/rerun-ai ─────────────────

const RerunBody = z.object({
  /** The user's research hint ("model number is X", "it's the 5mm one") —
   *  persisted into suggested_metadata.user_hint, which rides
   *  lookup_metadata into the matchmaker prompt as the authoritative
   *  correction. */
  hint: z.string().trim().max(500).optional(),
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
    if (!row.barcode_text) {
      // Photo-only path → re-run the vision identify (awaited here so the
      // response reflects the fresh result, unlike the detached POST).
      if (!row.image_file_id) {
        res.status(400).json({ error: { code: "no_input", message: "item has neither a barcode nor a photo" } });
        return;
      }
      await enrichPhotoItem({ db, orgId: ctx.org.id, itemId: id, imageFileId: row.image_file_id });
      void platform().events.emit("core-scan.scan.enriched", { orgId: ctx.org.id, itemId: id });
      await matchItem({
        orgId: ctx.org.id,
        orgSlug: ctx.org.slug,
        token,
        baseUrl: (req.headers["x-cobblr-base-url"] as string | undefined) ?? INTERNAL_API,
        itemId: id,
        force: true,
      });
      const freshPhoto = await db
        .selectFrom("core_scan_inbox_items")
        .selectAll()
        .where("id", "=", id)
        .executeTakeFirstOrThrow();
      res.json(freshPhoto);
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
    });

    // Stamp the user's hint AFTER enrichment (which rewrites
    // suggested_metadata) so the matchmaker sees it as user_hint.
    const hint = RerunBody.safeParse(req.body ?? {}).data?.hint;
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
      orgId: ctx.org.id,
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
// name (the companion app "OTHER PHOTO OPTIONS" strip). Read-only; picking one
// goes through POST /inbox/:id/catalog-image.

inboxRouter.get(
  "/inbox/:id/photo-options",
  asyncHandler(async (req, res) => {
    if (!requireRole(req, res, "owner", "admin", "member")) return;
    const id = req.params.id;
    const db = tenantDb(req);
    const row = await db
      .selectFrom("core_scan_inbox_items")
      .select(["suggested_name", "barcode_text"])
      .where("id", "=", id ?? "")
      .executeTakeFirst();
    const q = row?.suggested_name ?? row?.barcode_text;
    if (!q) {
      res.json({ items: [] });
      return;
    }
    const items = await searchImages(q, 8).catch(() => []);
    res.json({ items });
  }),
);

// ─────────────────── POST /inbox/:id/catalog-image ──────────────────
// Set the item's catalog image from a picked URL (photo-options strip or
// a pasted URL). Downloads into core-files so the image survives the
// external host; the URL is SSRF-guarded inside downloadCatalogImage.

const CatalogImageBody = z.object({ url: z.string().url().max(2000) });

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
      .select("id")
      .where("id", "=", id ?? "")
      .executeTakeFirst();
    if (!row) {
      res.status(404).json({ error: { code: "not_found", message: "inbox item not found" } });
      return;
    }
    await db
      .updateTable("core_scan_inbox_items")
      .set({ catalog_image_url: parsed.data.url, updated_at: new Date() })
      .where("id", "=", row.id)
      .execute();
    await downloadCatalogImage(
      { db, orgSlug: ctx.org.slug, bearer: token, itemId: row.id },
      parsed.data.url,
    );
    const fresh = await db
      .selectFrom("core_scan_inbox_items")
      .selectAll()
      .where("id", "=", row.id)
      .executeTakeFirstOrThrow();
    res.json(fresh);
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
  /** true = explicit re-rank (rerun / POST /match); false = intake
   *  auto-match, which SKIPS items already matched (matched_at stamp). */
  force: boolean;
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
        observeScanPhoto(opts.orgId, row.image_file_id, opts.itemId),
        new Promise<null>((resolve) => setTimeout(() => resolve(null), 15_000)),
      ]);
    }

    const menu = await assembleScanMenu(opts.baseUrl, opts.orgSlug, opts.token);
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
    await dbAfter
      .updateTable("core_scan_inbox_items")
      .set({
        suggested_candidates: JSON.stringify(candidates) as never,
        suggested_metadata: JSON.stringify({
          ...((row.suggested_metadata ?? {}) as Record<string, unknown>),
          ...(photoObservations ? { photo_observations: photoObservations } : {}),
          matched_at: new Date().toISOString(),
        }) as never,
        ...(top && typeof top === "object" && "notes" in top && (top as { notes?: string }).notes
          ? {
              ai_notes: (top as { notes: string }).notes,
              ai_confidence: String((top as { confidence: number }).confidence),
            }
          : {}),
        updated_at: new Date(),
      })
      .where("id", "=", opts.itemId)
      .execute();
    return candidates;
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
      orgId: ctx.org.id,
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
