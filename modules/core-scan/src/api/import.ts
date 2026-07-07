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

import { Router, text as expressText } from "express";
import { z } from "zod";
import multer from "multer";
import { bearer, sessionUser, tenantContext, tenantDb } from "../db.js";
import { asyncHandler, requireRole } from "./util.js";
import { assertSafeOutboundUrl } from "../services/enrich.js";
import {
  parseCsvImport,
  parseJsonImport,
  type ImportRowError,
  type NormalizedImportItem,
  type ParsedImport,
} from "../services/import.js";

export const importRouter = Router({ mergeParams: true });

const INTERNAL_API = `http://127.0.0.1:${process.env.API_PORT ?? 4000}`;
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

/** Fetch a photo URL (10s / 5MB / SSRF-guarded) and store it via core-files.
 *  Returns the file id, or throws with a user-facing message. */
async function fetchPhotoToFile(orgSlug: string, token: string, url: string): Promise<string> {
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
  const fd = new FormData();
  const ext = (res.headers.get("content-type") ?? "").includes("png") ? "png" : "jpg";
  fd.append("file", blob, `import-${Date.now()}.${ext}`);
  // INTERNAL_API on purpose: this call carries the caller's bearer, so it must
  // never target a caller-influenced URL.
  const up = await fetch(`${INTERNAL_API}/api/v1/orgs/${orgSlug}/modules/core-files/files`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
    body: fd,
  });
  if (!up.ok) throw new Error(`file store failed: HTTP ${up.status}`);
  return ((await up.json()) as { id: string }).id;
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
        has_photo: !!i.photo_identify_url,
      })),
    });
  }),
);

// ── POST /import ─────────────────────────────────────────────────────────────
importRouter.post(
  "/import",
  expressText({ type: ["text/csv", "text/plain"], limit: "32mb" }),
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

    const createdIds: string[] = [];
    const photoJobs: Array<{ id: string; identify: string | null; display: string | null; row: number }> = [];
    for (const p of toWrite) {
      const i = p.item;
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
        updated_at: new Date(),
      };
      try {
        if (p.action === "replace" && p.existingId) {
          await db.updateTable("core_scan_inbox_items").set(values).where("id", "=", p.existingId).execute();
          createdIds.push(p.existingId);
          if (fetchPhotos) photoJobs.push({ id: p.existingId, identify: i.photo_identify_url, display: i.photo_display_url, row: i.row });
        } else {
          const ins = await db
            .insertInto("core_scan_inbox_items")
            .values({ ...values, created_by_user_id: user?.id ?? null })
            .returning("id")
            .executeTakeFirstOrThrow();
          createdIds.push(ins.id);
          if (fetchPhotos) photoJobs.push({ id: ins.id, identify: i.photo_identify_url, display: i.photo_display_url, row: i.row });
        }
      } catch (e) {
        errors.push({ row: i.row, field: "", message: `insert failed: ${(e as Error).message}` });
      }
    }

    // Photos: best-effort, bounded concurrency, per-row errors — the batch
    // never aborts on a missing/unreachable photo.
    let photosFetched = 0;
    let photosFailed = 0;
    if (fetchPhotos) {
      await mapLimit(photoJobs, PHOTO_CONCURRENCY, async (job) => {
        for (const [role, url] of [["identify", job.identify], ["display", job.display]] as const) {
          if (!url) continue;
          try {
            const fileId = await fetchPhotoToFile(ctx.org.slug, token, url);
            await db
              .updateTable("core_scan_inbox_items")
              .set(role === "identify" ? { image_file_id: fileId, updated_at: new Date() } : { catalog_image_file_id: fileId, updated_at: new Date() })
              .where("id", "=", job.id)
              .execute();
            photosFetched++;
          } catch (e) {
            photosFailed++;
            errors.push({ row: job.row, field: `${role}_photo_url`, message: (e as Error).message });
          }
        }
      });
    }

    res.json({
      imported_count: createdIds.length,
      skipped_count: plan.length - toWrite.length,
      errors,
      created_ids: createdIds,
      photos_fetched: photosFetched,
      photos_failed: photosFailed,
    });
  }),
);
