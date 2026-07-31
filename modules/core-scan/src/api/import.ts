// Scan-inbox bulk IMPORT — one-shot, user-triggered. Accepts an
// inbox export natively (JSON envelope or CSV; contract: the inbox-export interop spec v1) and any other system's CSV via a column
// `mapping`. The parse/translate half lives in ../services/import.ts (pure);
// this router owns idempotency, row insertion, and best-effort photo fetch.
//
//   POST /import          — dry_run, duplicate_policy=skip|append|replace, fetch_photos
//   POST /import/preview  — detected columns + first rows, never writes
//
// Imported items land as ordinary inbox rows (status pending unless the
// source discarded them) with every hint in suggested_metadata — including
// user_hint, which the matchmaker's prompt already honours as a tie-breaker —
// so Cobblr's OWN matchmaker routes them (§3: hints, not hard bindings).
// Nothing here auto-fires AI: 500 imported rows must not mean 500 surprise
// model calls. The inbox's existing suggest/rerun flows pick them up.

import { Router, json as expressJson, text as expressText } from "express";
import { z } from "zod";
import multer from "multer";
import { platform } from "@cobblr/platform-contract";
import type { Transaction } from "kysely";
import { bearer, sessionUser, tenantContext, tenantDb, type CoreScanDB } from "../db.js";

/** An open transaction on a tenant db. The import does every one of its writes
 *  inside one, so a failure rolls the whole import back. */
type TenantTrx = Transaction<CoreScanDB>;
import { asyncHandler, requireRole } from "./util.js";
import { assertSafeOutboundUrl } from "../services/enrich.js";
import {
  parseCsvImport,
  parseJsonImport,
  type ImportRowError,
  type NormalizedImportBatch,
  type NormalizedImportItem,
  type ParsedImport,
} from "../services/import.js";

export const importRouter = Router({ mergeParams: true });

const PHOTO_TIMEOUT_MS = 10_000;
const PHOTO_MAX_BYTES = 5 * 1024 * 1024;
const PHOTO_CONCURRENCY = 4;
const MAX_UPLOAD_BYTES = 32 * 1024 * 1024;

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_UPLOAD_BYTES } });

const QuerySchema = z.object({
  dry_run: z.enum(["true", "false"]).optional(),
  duplicate_policy: z.enum(["skip", "append", "replace"]).optional(),
  fetch_photos: z.enum(["true", "false"]).optional(),
});

/** Parse whichever body arrived: multipart `file` (CSV or JSON by extension /
 *  content), raw text/csv, or a JSON body. `mapping` comes from a multipart
 *  field or the JSON body's top level. */
function parseRequest(req: {
  file?: { originalname?: string; mimetype?: string; buffer: Buffer };
  headers: Record<string, unknown>;
  body: unknown;
}): ParsedImport {
  const bodyObj = (req.body ?? {}) as Record<string, unknown>;
  let mapping: Record<string, string> | undefined;
  const mRaw = bodyObj.mapping;
  if (typeof mRaw === "string" && mRaw.trim()) {
    try {
      mapping = JSON.parse(mRaw) as Record<string, string>;
    } catch {
      /* surfaced below as a normal parse of the file without mapping */
    }
  } else if (mRaw && typeof mRaw === "object") mapping = mRaw as Record<string, string>;

  if (req.file) {
    const name = (req.file.originalname ?? "").toLowerCase();
    const text = req.file.buffer.toString("utf8");
    const looksJson = name.endsWith(".json") || req.file.mimetype === "application/json" || text.trimStart().startsWith("{") || text.trimStart().startsWith("[");
    if (looksJson) {
      try {
        return parseJsonImport(JSON.parse(text));
      } catch (e) {
        return { source: null, source_instance: null, items: [], errors: [{ row: 0, field: "", message: `invalid JSON: ${(e as Error).message}` }] };
      }
    }
    return parseCsvImport(text, mapping);
  }

  const ct = String(req.headers["content-type"] ?? "");
  if (ct.includes("text/csv")) {
    return parseCsvImport(String(req.body ?? ""), mapping);
  }
  // Raw JSON body: the envelope itself, or { items, mapping }.
  return parseJsonImport(bodyObj);
}

/** All already-imported provenance keys for this workspace, in one query. */
async function existingProvenance(db: ReturnType<typeof tenantDb>): Promise<Map<string, string>> {
  const rows = await db
    .selectFrom("core_scan_inbox_items")
    .select(["id", "suggested_metadata"])
    .where("suggested_metadata", "is not", null)
    .execute();
  const map = new Map<string, string>();
  for (const r of rows) {
    const p = (r.suggested_metadata as { import_provenance?: { source_id?: unknown; source_instance?: unknown } } | null)?.import_provenance;
    if (p && p.source_id !== undefined) {
      map.set(`${String(p.source_instance ?? "")}::${String(p.source_id)}`, r.id);
    }
  }
  return map;
}

const provKey = (i: NormalizedImportItem): string | null =>
  i.provenance ? `${String(i.provenance.source_instance ?? "")}::${i.provenance.source_id}` : null;

/**
 * Recreate the exported SESSIONS locally and return sourceId → local batch id.
 *
 * A batch carries its origin id in `origin` as `import:<source_id>`, which is
 * both the provenance stamp and the idempotency key: syncing the same prod
 * inbox twice reuses the session instead of cloning it, so items added to a
 * session later land in the SAME session here. Best-effort per batch - a
 * session that fails to create just leaves its items ungrouped rather than
 * failing the whole import.
 */
async function upsertBatches(
  db: TenantTrx,
  batches: NormalizedImportBatch[],
  orgId: string,
  userId: string | null,
): Promise<{ map: Map<string, string>; created: string[] }> {
  const map = new Map<string, string>();
  const created: string[] = [];
  if (batches.length === 0) return { map, created };
  const stamps = batches.map((b) => `import:${b.source_id}`);
  const existing = await db
    .selectFrom("core_scan_batches")
    .select(["id", "origin"])
    .where("origin", "in", stamps)
    .execute();
  for (const r of existing) {
    const src = String(r.origin ?? "").replace(/^import:/, "");
    if (src) map.set(src, r.id as string);
  }
  for (const b of batches) {
    if (map.has(b.source_id)) continue;
    try {
      const ins = await db
        .insertInto("core_scan_batches")
        .values({
          label: b.label,
          origin: `import:${b.source_id}`,
          vendor: b.vendor,
          order_ref: b.order_ref,
          created_by_user_id: userId,
          ...(b.created_at && !Number.isNaN(Date.parse(b.created_at))
            ? { created_at: new Date(b.created_at) }
            : {}),
        })
        .returning("id")
        .executeTakeFirstOrThrow();
      map.set(b.source_id, ins.id as string);
      created.push(ins.id as string);
      // The receipt this session was parsed from, so the inbox's "Original"
      // button still works on the destination. Embedded bytes only - a link
      // would point back at an instance the destination may not reach.
      if (b.document_embedded) {
        try {
          const fileId = await storeEmbeddedToFile(orgId, b.document_embedded);
          await db
            .updateTable("core_scan_batches")
            .set({ source_file_id: fileId })
            .where("id", "=", ins.id as string)
            .execute();
        } catch {
          /* no original → the session still imports, just without its receipt */
        }
      }
    } catch {
      /* a session that won't create leaves its items ungrouped, not the import failed */
    }
  }
  return { map, created };
}

/** Fetch a photo URL (10s / 5MB / SSRF-guarded) and store it via core-files.
 *  Returns the file id, or throws with a user-facing message. Stores through the
 *  platform files seam (in-process), NOT the HTTP upload route — a fetched photo
 *  is not a user upload, so it must bypass any gate on that route. */
async function fetchPhotoToFile(orgId: string, url: string): Promise<string> {
  // CI/test escape, same convention as the webhook + machine guards: the test
  // suite spins a loopback photo server and CI sets COBBLR_TEST_CALLBACK_HOST.
  const testHost = process.env.COBBLR_TEST_CALLBACK_HOST;
  if (!(testHost && new URL(url).hostname === testHost)) assertSafeOutboundUrl(url);
  let res: Response;
  try {
    res = await fetch(url, { headers: { "user-agent": "cobblr-core-scan-import/1" }, signal: AbortSignal.timeout(PHOTO_TIMEOUT_MS) });
  } catch (e) {
    const msg = (e as Error).name === "TimeoutError" ? "timed out" : (e as Error).message;
    const tailnet = /\.ts\.net(\/|:|$)/.test(url) ? " (a *.ts.net tailnet URL — reachable only if this Cobblr is on the same tailnet; rehost the photos or re-run the import from a tailnet-connected instance)" : "";
    throw new Error(`fetch failed: ${msg}${tailnet}`);
  }
  if (!res.ok) throw new Error(`source returned HTTP ${res.status}`);
  const len = Number(res.headers.get("content-length") ?? 0);
  if (len > PHOTO_MAX_BYTES) throw new Error(`photo larger than ${PHOTO_MAX_BYTES / 1024 / 1024}MB cap`);
  const blob = await res.blob();
  if (blob.size > PHOTO_MAX_BYTES) throw new Error(`photo larger than ${PHOTO_MAX_BYTES / 1024 / 1024}MB cap`);
  const contentType = res.headers.get("content-type") ?? "";
  const ext = contentType.includes("png") ? "png" : "jpg";
  const written = await platform().files.write(orgId, new Uint8Array(await blob.arrayBuffer()), {
    filename: `import-${Date.now()}.${ext}`,
    mimeType: blob.type || contentType || "image/jpeg",
  });
  if (!written) throw new Error("file store failed");
  return written.fileId;
}

/** Store a baked-in (embed-mode) photo: decode its base64 and hand the bytes to
 *  core-files. NO network — this is the offline / LAN-only import path. */
async function storeEmbeddedToFile(orgId: string, embed: { mime: string; data: string }): Promise<string> {
  const bytes = Buffer.from(embed.data, "base64");
  if (bytes.byteLength === 0) throw new Error("embedded photo is empty / not valid base64");
  if (bytes.byteLength > PHOTO_MAX_BYTES) throw new Error(`embedded photo larger than ${PHOTO_MAX_BYTES / 1024 / 1024}MB cap`);
  const ext = embed.mime.includes("png") ? "png" : embed.mime.includes("webp") ? "webp" : "jpg";
  const written = await platform().files.write(orgId, new Uint8Array(bytes), {
    filename: `import-${Date.now()}.${ext}`,
    mimeType: embed.mime,
  });
  if (!written) throw new Error("file store failed");
  return written.fileId;
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      for (;;) {
        const i = next++;
        if (i >= items.length) return;
        out[i] = await fn(items[i]!);
      }
    }),
  );
  return out;
}

// ── POST /import/preview — parse + mapping report, never writes ─────────────
importRouter.post(
  "/import/preview",
  expressText({ type: ["text/csv", "text/plain"], limit: "32mb" }),
  // A JSON envelope needs the SAME headroom as a CSV. It did not have it:
  // CSV was raised to 32mb here while application/json fell through to the
  // app-level parser default (~100kb), so an embed-mode export - the very
  // thing this endpoint exists to consume - was rejected with
  // PayloadTooLargeError. A real 69-item export is 5.4MB (2026-07-31).
  expressJson({ limit: "32mb" }),
  upload.single("file"),
  asyncHandler(async (req, res) => {
    if (!requireRole(req, res, "owner", "admin", "member")) return;
    const parsed = parseRequest(req as never);
    res.json({
      source: parsed.source,
      source_instance: parsed.source_instance,
      count: parsed.items.length,
      columns: parsed.columns ?? null,
      errors: parsed.errors,
      rows: parsed.items.slice(0, 5).map((i) => ({
        row: i.row,
        name: i.suggested_name,
        barcode: i.barcode,
        status: i.status,
        source_kind: i.source_kind,
        quantity: i.quantity,
        scan_area: i.scan_area,
        hint_category: i.metadata.hint_category ?? null,
        has_photo: !!(i.photo_identify_url || i.photo_identify_embedded),
      })),
    });
  }),
);

// ── POST /import ─────────────────────────────────────────────────────────────
importRouter.post(
  "/import",
  expressText({ type: ["text/csv", "text/plain"], limit: "32mb" }),
  // A JSON envelope needs the SAME headroom as a CSV. It did not have it:
  // CSV was raised to 32mb here while application/json fell through to the
  // app-level parser default (~100kb), so an embed-mode export - the very
  // thing this endpoint exists to consume - was rejected with
  // PayloadTooLargeError. A real 69-item export is 5.4MB (2026-07-31).
  expressJson({ limit: "32mb" }),
  upload.single("file"),
  asyncHandler(async (req, res) => {
    if (!requireRole(req, res, "owner", "admin", "member")) return;
    const q = QuerySchema.safeParse(req.query);
    if (!q.success) {
      res.status(400).json({ error: { code: "bad_query", message: "bad query params", details: q.error.issues } });
      return;
    }
    const dryRun = q.data.dry_run === "true";
    const policy = q.data.duplicate_policy ?? "skip";
    const fetchPhotos = q.data.fetch_photos !== "false";

    const parsed = parseRequest(req as never);
    const errors: ImportRowError[] = [...parsed.errors];
    if (parsed.items.length === 0) {
      res.status(errors.length ? 400 : 200).json({
        imported_count: 0, skipped_count: 0, errors, created_ids: [], photos_fetched: 0, photos_failed: 0,
      });
      return;
    }

    const db = tenantDb(req);
    const ctx = tenantContext(req);
    const user = sessionUser(req);
    const token = bearer(req) ?? "";

    const existing = await existingProvenance(db);
    // Also dedupe within the file itself (same source_id twice in one export).
    const seenInFile = new Set<string>();

    type Plan = { item: NormalizedImportItem; action: "create" | "skip" | "replace"; existingId?: string };
    const plan: Plan[] = parsed.items.map((item) => {
      const key = provKey(item);
      if (!key || policy === "append") return { item, action: "create" as const };
      if (seenInFile.has(key)) return { item, action: "skip" as const };
      seenInFile.add(key);
      const existingId = existing.get(key);
      if (!existingId) return { item, action: "create" as const };
      return policy === "replace" ? { item, action: "replace" as const, existingId } : { item, action: "skip" as const, existingId };
    });

    const toWrite = plan.filter((p) => p.action !== "skip");
    if (dryRun) {
      res.json({
        imported_count: toWrite.length,
        skipped_count: plan.length - toWrite.length,
        errors,
        created_ids: [],
        photos_fetched: 0,
        photos_failed: 0,
        dry_run: true,
      });
      return;
    }

    // ── Where the source had things filed, as a SUGGESTION ───────────────
    // The export carries the location by NAME (its uuid is meaningless here).
    // An exact, unambiguous name match adopts the local location; anything else
    // leaves the name visible in the location note rather than dropping it, and
    // never guesses a nearby match - filing something into the wrong room is
    // worse than filing it nowhere.
    const localLocations = new Map<string, string[]>();
    if (parsed.items.some((i) => i.x_location_name)) {
      try {
        const locs = await platform().entities.list(ctx.org.id, "core-locations:location", { limit: 2000 });
        for (const l of locs.items) {
          const name = (l.title ?? String((l.fields as Record<string, unknown>)?.name ?? "")).trim().toLowerCase();
          if (!name) continue;
          localLocations.set(name, [...(localLocations.get(name) ?? []), String(l.id)]);
        }
      } catch {
        /* no locations module here → every name stays a note */
      }
    }
    for (const i of parsed.items) {
      if (!i.x_location_name) continue;
      const hit = localLocations.get(i.x_location_name.trim().toLowerCase());
      if (hit && hit.length === 1) i.x_target_location_id = hit[0]!;
      else if (!i.x_location_note) i.x_location_note = i.x_location_name;
    }

    // ── Photos FIRST, outside the transaction ────────────────────────────
    // Resolving bytes to a stored file id is slow (a fetch can take seconds) and
    // must not hold a write transaction open. Doing it up front also means the
    // row lands WITH its images already attached, so there is no window where an
    // item exists without its photo - and a photo that cannot be stored costs
    // that item its image, never the import.
    let photosFetched = 0;
    let photosFailed = 0;
    const photoIds = new Map<number, { identify?: string; display?: string }>();
    await mapLimit(toWrite, PHOTO_CONCURRENCY, async (p) => {
      const i = p.item;
      const roles = [
        ["identify", fetchPhotos ? i.photo_identify_url : null, i.photo_identify_embedded],
        ["display", fetchPhotos ? i.photo_display_url : null, i.photo_display_embedded],
      ] as const;
      for (const [role, url, embed] of roles) {
        if (!embed && !url) continue;
        try {
          const fileId = embed
            ? await storeEmbeddedToFile(ctx.org.id, embed)
            : await fetchPhotoToFile(ctx.org.id, url!);
          const slot = photoIds.get(i.row) ?? {};
          slot[role] = fileId;
          photoIds.set(i.row, slot);
          photosFetched++;
        } catch (e) {
          photosFailed++;
          errors.push({ row: i.row, field: embed ? `${role}_photo_embedded` : `${role}_photo_url`, message: (e as Error).message });
        }
      }
    });

    // ── Then ONE transaction for every row ───────────────────────────────
    // All of it lands or none of it does. A bulk import that half-succeeds
    // leaves an inbox nobody can reason about: some items new, some updated,
    // some untouched, and no way to tell which without reading them all. Any
    // failure here rolls the whole thing back and the caller gets an error
    // instead of a partial success (the author, 2026-07-31: "if it fails it fails
    // completely, no half of the items as fragments making it through").
    const createdIds: string[] = [];
    const createdBatchIds: string[] = [];
    const replacedBefore: Array<{ id: string; before: Record<string, unknown> }> = [];
    let runId: string | null = null;

    try {
      await db.transaction().execute(async (trx) => {
        // Sessions first, so every item can point at a local batch id.
        const { map: batchIdBySource, created } = await upsertBatches(
          trx,
          parsed.batches ?? [],
          ctx.org.id,
          user?.id ?? null,
        );
        createdBatchIds.push(...created);

        for (const p of toWrite) {
          const i = p.item;
          const localBatch = i.x_batch_source_id ? (batchIdBySource.get(i.x_batch_source_id) ?? null) : null;
          const photos = photoIds.get(i.row) ?? {};
          const values = {
            status: i.status,
            source_kind: i.source_kind,
            barcode_text: i.barcode,
            source_url: i.source_url,
            suggested_name: i.suggested_name,
            suggested_sku: i.suggested_sku,
            suggested_metadata: i.metadata,
            ai_notes: i.ai_notes,
            // numeric(3,2) rides as a string through kysely
            ai_confidence: i.ai_confidence === null ? null : i.ai_confidence.toFixed(2),
            scan_area: i.scan_area,
            quantity: i.quantity,
            // Cobblr→Cobblr richness restored from x_cobblr. A foreign CSV leaves
            // these null and behaves exactly as before.
            suggested_manufacturer: i.x_manufacturer,
            suggested_location_note: i.x_location_note,
            target_kind: i.x_entity_type,
            scan_batch_id: localBatch,
            updated_at: new Date(),
            ...(photos.identify ? { image_file_id: photos.identify } : {}),
            ...(photos.display ? { catalog_image_file_id: photos.display } : {}),
            // An external catalog link is the ONLY visual a third of a real
            // inbox has. Keep it verbatim; the card renders it directly, same
            // as the source does, with no fetch.
            ...(i.x_catalog_image_url ? { catalog_image_url: i.x_catalog_image_url } : {}),
            // jsonb ARRAY column: it must be handed a JSON STRING, not a JS
            // array. node-pg renders a JS array as a Postgres array literal
            // ({...}), which the jsonb column rejects with "invalid input
            // syntax for type json" - and because every write is one
            // transaction now, that single bad value rolls back the entire
            // import. (A plain object is fine, which is why suggested_metadata
            // above needs no cast; only arrays are ambiguous.) The `as never`
            // matches the other jsonb-array writers in this module: the Kysely
            // column type says unknown[], the driver wants text.
            ...(Array.isArray(i.x_candidates)
              ? { suggested_candidates: JSON.stringify(i.x_candidates) as never }
              : {}),
            ...(i.x_target_location_id ? { target_location_id: i.x_target_location_id } : {}),
          };
          if (p.action === "replace" && p.existingId) {
            // Snapshot what we are about to overwrite, so the run is reversible.
            const before = await trx
              .selectFrom("core_scan_inbox_items")
              .selectAll()
              .where("id", "=", p.existingId)
              .executeTakeFirst();
            if (before) replacedBefore.push({ id: p.existingId, before: before as unknown as Record<string, unknown> });
            await trx.updateTable("core_scan_inbox_items").set(values).where("id", "=", p.existingId).execute();
            createdIds.push(p.existingId);
          } else {
            const ins = await trx
              .insertInto("core_scan_inbox_items")
              .values({
                ...values,
                created_by_user_id: user?.id ?? null,
                // Sessions group by TIME, so stamping import-time here would
                // collapse months of scanning into one bogus session.
                ...(i.x_created_at && !Number.isNaN(Date.parse(i.x_created_at))
                  ? { created_at: new Date(i.x_created_at) }
                  : {}),
              })
              .returning("id")
              .executeTakeFirstOrThrow();
            createdIds.push(ins.id);
          }
        }

        // The run record is written in the SAME transaction, so a recorded run
        // always describes rows that actually exist.
        const run = await trx
          .insertInto("core_scan_import_runs")
          .values({
            created_by_user_id: user?.id ?? null,
            source_instance: parsed.source_instance,
            source_label: parsed.source,
            item_count: toWrite.length,
            created_count: createdIds.length - replacedBefore.length,
            replaced_count: replacedBefore.length,
            undo: {
              created_item_ids: createdIds.filter((id) => !replacedBefore.some((r) => r.id === id)),
              created_batch_ids: createdBatchIds,
              replaced: replacedBefore,
            },
          })
          .returning("id")
          .executeTakeFirstOrThrow();
        runId = run.id;
      });
    } catch (e) {
      res.status(500).json({
        error: {
          code: "import_failed",
          message: `import rolled back, nothing was written: ${(e as Error).message}`,
        },
        errors,
        photos_fetched: photosFetched,
        photos_failed: photosFailed,
      });
      return;
    }

    res.json({
      imported_count: createdIds.length,
      skipped_count: plan.length - toWrite.length,
      errors,
      created_ids: createdIds,
      photos_fetched: photosFetched,
      photos_failed: photosFailed,
      // The handle for one-click undo.
      run_id: runId,
    });
  }),
);

// ──────────────── Import runs: list + one-click undo ────────────────────────
// A bulk import is the one scan operation a person cannot unpick by hand, and
// with duplicate_policy=replace it overwrites rows that were already there. So
// every run records what it created and the prior contents of what it replaced,
// and this reverses it in one call (the author, 2026-07-31: "1 click reversible in the
// event of an issue").

importRouter.get(
  "/import/runs",
  asyncHandler(async (req, res) => {
    if (!requireRole(req, res, "owner", "admin", "member")) return;
    const rows = await tenantDb(req)
      .selectFrom("core_scan_import_runs")
      .select([
        "id", "created_at", "source_instance", "source_label",
        "item_count", "created_count", "replaced_count", "undone_at",
      ])
      .orderBy("created_at", "desc")
      .limit(25)
      .execute();
    res.json({ items: rows });
  }),
);

// AI-REACH: exempt - a destructive BULK reversal (it deletes rows and rewrites
// others from a snapshot), owner/admin only, and it only makes sense against a
// specific run the person is looking at. "Undo the import" is exactly the kind
// of instruction that is cheap to say, ambiguous about WHICH import, and
// expensive to get wrong, so the affordance belongs next to the run in the UI
// rather than in a chat turn. Listing runs (the GET above) is not restricted.
importRouter.post(
  "/import/runs/:id/undo",
  asyncHandler(async (req, res) => {
    if (!requireRole(req, res, "owner", "admin")) return;
    const id = String(req.params.id ?? "");
    const db = tenantDb(req);
    const run = await db
      .selectFrom("core_scan_import_runs")
      .selectAll()
      .where("id", "=", id)
      .executeTakeFirst();
    if (!run) {
      res.status(404).json({ error: { code: "not_found", message: "no such import run" } });
      return;
    }
    if (run.undone_at) {
      res.status(409).json({ error: { code: "already_undone", message: "this import has already been undone" } });
      return;
    }
    const undo = (run.undo ?? {}) as {
      created_item_ids?: string[];
      created_batch_ids?: string[];
      replaced?: Array<{ id: string; before: Record<string, unknown> }>;
    };

    let removed = 0;
    let restored = 0;
    // The reversal is itself one transaction: an undo that half-applied would
    // be strictly worse than the import it was meant to fix.
    await db.transaction().execute(async (trx) => {
      const createdIds = undo.created_item_ids ?? [];
      if (createdIds.length) {
        const del = await trx
          .deleteFrom("core_scan_inbox_items")
          .where("id", "in", createdIds)
          .executeTakeFirst();
        removed = Number(del.numDeletedRows ?? 0);
      }
      for (const r of undo.replaced ?? []) {
        // Put back exactly what was there, minus the identity/timestamp columns
        // Postgres owns.
        const { id: _id, created_at: _c, ...rest } = r.before as Record<string, unknown>;
        await trx
          .updateTable("core_scan_inbox_items")
          .set(rest as never)
          .where("id", "=", r.id)
          .execute();
        restored++;
      }
      // Only drop a session this run created AND that nothing else now lives in.
      for (const batchId of undo.created_batch_ids ?? []) {
        const still = await trx
          .selectFrom("core_scan_inbox_items")
          .select("id")
          .where("scan_batch_id", "=", batchId)
          .limit(1)
          .executeTakeFirst();
        if (!still) await trx.deleteFrom("core_scan_batches").where("id", "=", batchId).execute();
      }
      await trx
        .updateTable("core_scan_import_runs")
        .set({ undone_at: new Date() })
        .where("id", "=", id)
        .execute();
    });

    res.json({ undone: true, run_id: id, items_removed: removed, items_restored: restored });
  }),
);
