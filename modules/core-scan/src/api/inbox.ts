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
import { enrichBarcodeItem } from "../services/enrich.js";

export const inboxRouter = Router({ mergeParams: true });

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

    // v0.1: require either a barcode or an image_file_id. The
    // photo-only AI path lands when image_file_id is set but no
    // barcode — today we stage that as pending+no-enrichment so
    // the user fills it in manually. v0.2 wires the
    // classify-image queue worker.
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

    const inserted = await db
      .insertInto("core_scan_inbox_items")
      .values({
        source_kind: body.source_kind,
        barcode_text: body.barcode ?? null,
        source_url: body.source_url ?? null,
        image_file_id: body.image_file_id ?? null,
        scan_batch_id: body.scan_batch_id ?? null,
        scan_area: body.scan_area ?? null,
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
        (req.headers["x-cobblr-base-url"] as string | undefined) ??
        `${req.protocol}://${req.headers.host ?? "localhost"}`;
      const enrichTask = enrichBarcodeItem({
        db,
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

    const fresh = await db
      .selectFrom("core_scan_inbox_items")
      .selectAll()
      .where("id", "=", inserted.id)
      .executeTakeFirstOrThrow();
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

// ──────────────────────── POST /inbox/:id/confirm ──────────────────

const ConfirmBody = z.object({
  target_module: z.string().min(1).max(80),
  target_kind: z.string().min(1).max(80),
  /** Name override. Falls back to suggested_name if absent. */
  name: z.string().min(1).max(160).optional(),
  location_id: z.string().uuid().optional(),
  /** Module-specific extras forwarded verbatim to the create endpoint. */
  extras: z.record(z.unknown()).optional(),
});

const KIND_CREATE_ENDPOINTS: Record<string, string> = {
  "inventory:part": "inventory/parts",
  "machines:machine": "machines/machines",
  "assets:asset": "assets/assets",
};

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

    const kindKey = `${parsed.data.target_module}:${parsed.data.target_kind}`;
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

    // Build the create body. Defaults from the suggestion +
    // extras win.
    const meta = (row.suggested_metadata as Record<string, unknown> | null) ?? {};
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
      },
      ...(parsed.data.location_id ? { location_id: parsed.data.location_id } : {}),
      ...(parsed.data.extras ?? {}),
    };

    // Re-issue through the api against the SAME bearer token so
    // requireAuth + withTenant + role gating fire on the target
    // endpoint.
    const baseUrl =
      (req.headers["x-cobblr-base-url"] as string | undefined) ??
      `${req.protocol}://${req.headers.host ?? "localhost"}`;
    const createUrl = `${baseUrl}/api/v1/orgs/${ctx.org.slug}/modules/${createPath}`;
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
            source_module: parsed.data.target_module,
            source_type: parsed.data.target_kind,
            source_id: created.id,
            role: "gallery",
          }),
        });
        // Optionally also point image_path at the catalog photo.
        await fetch(`${baseUrl}/api/v1/orgs/${ctx.org.slug}/modules/${createPath}/${created.id}`, {
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
        target_module: parsed.data.target_module,
        target_kind: parsed.data.target_kind,
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
      targetModule: parsed.data.target_module,
      targetKind: parsed.data.target_kind,
      entityId: created.id,
    });

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
      // Photo-only path — v0.2.
      res.status(400).json({
        error: {
          code: "no_barcode",
          message: "Photo-only rerun is v0.2. Today this only re-runs the barcode lookup.",
        },
      });
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
      (req.headers["x-cobblr-base-url"] as string | undefined) ??
      `${req.protocol}://${req.headers.host ?? "localhost"}`;
    await enrichBarcodeItem({
      db,
      itemId: id,
      orgSlug: ctx.org.slug,
      bearer: token,
      baseUrl,
      upc: row.barcode_text,
    });

    const fresh = await db
      .selectFrom("core_scan_inbox_items")
      .selectAll()
      .where("id", "=", id)
      .executeTakeFirstOrThrow();
    res.json(fresh);
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
