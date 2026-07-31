// Scan-inbox bulk EXPORT — the mirror of api/import.ts. Emits the workspace's
// scan inbox in the INBOX_EXPORT_INTEROP v1 envelope (JSON or CSV), so it
// round-trips straight back into another Cobblr (or an external system) via the
// importer — no DB surgery. Photo URLs point at the no-auth, token-gated
// image route so the importer's best-effort photo fetch carries the images.
//
//   GET  /export           → JSON envelope   (?status=all|pending|discarded, ?batch=<id>) — link photos, legacy
//   GET  /export.csv       → flattened CSV    (same filters)
//   GET  /export/options   → the export modal's config (default photo mode + TTL choices)
//   POST /export           → JSON envelope with a chosen SELECTION + photo mode + TTL
//                            body { ids?, status?, batch?, photo_mode, ttl_ms }

import { Router } from "express";
import type { Request } from "express";
import { z } from "zod";
import { platform } from "@cobblr/platform-contract";
import { tenantContext, tenantDb } from "../db.js";
import { asyncHandler, badBody, requireRole } from "./util.js";
import {
  buildEnvelope,
  buildCsv,
  type ScanRowForExport,
  type BatchRowForExport,
  type PhotoResolver,
  type EmbeddedPhoto,
} from "../services/export.js";
import { signExportToken } from "../services/export-token.js";

export const exportRouter = Router({ mergeParams: true });

// ── Photo mode + TTL policy ──────────────────────────────────────────────────
// Default photo mode is deploy-configurable: a self-hoster should default to
// `embed` (self-contained, no public links, works LAN-only / offline); a hosted
// instance can set SCAN_EXPORT_DEFAULT_PHOTO_MODE=link (small files, links fetched
// on import). The export modal always lets the user override per-export.
type PhotoMode = "link" | "embed" | "none";
function defaultPhotoMode(): PhotoMode {
  const v = (process.env.SCAN_EXPORT_DEFAULT_PHOTO_MODE ?? "embed").toLowerCase();
  return v === "link" || v === "none" ? v : "embed";
}
const TTL_CHOICES = [
  { label: "1 hour", ms: 60 * 60 * 1000 },
  { label: "24 hours", ms: 24 * 60 * 60 * 1000 },
  { label: "7 days", ms: 7 * 24 * 60 * 60 * 1000 },
] as const;
const DEFAULT_TTL_MS = TTL_CHOICES[1].ms; // 24h
const MIN_TTL_MS = 60 * 1000;
const MAX_TTL_MS = TTL_CHOICES[2].ms; // 7d
/** Per-photo embed cap: skip baking in an unusually large file rather than
 *  bloat the export past reason (it's still recoverable via a re-export as a
 *  link). Typical scan photos are well under this. */
const EMBED_MAX_BYTES = 10 * 1024 * 1024;

/** The instance origin to build absolute photo URLs against: an
 *  `x-cobblr-base-url` override (isolated-stack e2e), else the request's own
 *  forwarded proto + host. Same precedence labels' QR half uses. */
function baseUrl(req: Request): string {
  const header = req.headers["x-cobblr-base-url"];
  if (typeof header === "string" && header) return header.replace(/\/+$/, "");
  const proto = (req.headers["x-forwarded-proto"] as string | undefined)?.split(",")[0] ?? req.protocol;
  return `${proto}://${req.headers.host ?? "localhost"}`;
}

const EXPORT_COLS = [
  "id", "status", "barcode_text", "source_url", "image_file_id",
  "catalog_image_file_id", "catalog_image_url", "suggested_name",
  "suggested_manufacturer", "suggested_sku", "suggested_metadata", "ai_notes",
  "ai_confidence", "target_kind", "scan_area", "quantity",
  "suggested_candidates", "suggested_location_note", "scan_batch_id",
  "target_location_id", "created_at", "updated_at",
] as const;

async function loadRows(
  req: Request,
  sel: { status?: string; batchId?: string | null; ids?: string[] | null } = {},
): Promise<{ rows: ScanRowForExport[]; batches: BatchRowForExport[]; status: string; batchId: string | null }> {
  const db = tenantDb(req);
  const statusQ = sel.status ?? (typeof req.query.status === "string" ? req.query.status : "all");
  const batchId = sel.batchId ?? (typeof req.query.batch === "string" && req.query.batch ? req.query.batch : null);
  let q = db.selectFrom("core_scan_inbox_items").select(EXPORT_COLS as unknown as (typeof EXPORT_COLS)[number][]);
  // An explicit id selection is the primary filter (the export modal's checked
  // items); status/batch are the fallback for the legacy GET.
  if (sel.ids && sel.ids.length) q = q.where("id", "in", sel.ids);
  else {
    if (statusQ !== "all") q = q.where("status", "=", statusQ as never);
    if (batchId) q = q.where("scan_batch_id", "=", batchId);
  }
  const rows = (await q.orderBy("created_at", "asc").execute()) as unknown as ScanRowForExport[];
  const batches = await loadBatches(db, rows);
  return { rows, batches, status: sel.ids?.length ? "selection" : statusQ, batchId };
}

/** The sessions the exported rows belong to. Derived from the ITEMS rather than
 *  the whole table, so exporting one session carries exactly that one and a
 *  selection carries only the sessions it touches. */
async function loadBatches(
  db: ReturnType<typeof tenantDb>,
  rows: ScanRowForExport[],
): Promise<BatchRowForExport[]> {
  const ids = [...new Set(rows.map((r) => r.scan_batch_id).filter((v): v is string => !!v))];
  if (ids.length === 0) return [];
  return (await db
    .selectFrom("core_scan_batches")
    .select(["id", "label", "origin", "vendor", "order_ref", "source_file_id", "created_at"])
    .where("id", "in", ids)
    .orderBy("created_at", "asc")
    .execute()) as unknown as BatchRowForExport[];
}

/** A `link`-mode resolver: one PER-FILE signed token baked into each URL (scoped
 *  to exactly that file, TTL from the modal), so the export leaks no more than
 *  the files it names, and only for as long as the user chose. */
function linkResolver(req: Request, orgId: string, ttlMs: number): PhotoResolver {
  const base = baseUrl(req);
  return (fileId) => ({
    url: `${base}/api/v1/public/scan-export/${signExportToken(orgId, fileId, ttlMs)}/files/${fileId}/raw`,
  });
}

/** An `embed`-mode resolver: pre-read every referenced file's bytes and base64
 *  them, so the export is fully self-contained (no public links, works offline /
 *  LAN-only). Files over the cap (or unreadable / non-image) are simply omitted. */
async function embedResolver(
  orgId: string,
  rows: ScanRowForExport[],
  batches: BatchRowForExport[] = [],
): Promise<PhotoResolver> {
  const fileIds = new Set<string>();
  for (const r of rows) {
    if (r.image_file_id) fileIds.add(r.image_file_id);
    if (r.catalog_image_file_id) fileIds.add(r.catalog_image_file_id);
  }
  // A receipt session's original document rides along too - it is the evidence
  // behind every line the parser produced, and the inbox's "Original" button.
  for (const b of batches) if (b.source_file_id) fileIds.add(b.source_file_id);
  const map = new Map<string, EmbeddedPhoto>();
  await Promise.all(
    [...fileIds].map(async (id) => {
      try {
        const f = (await platform().files.read(orgId, id, "medium")) ?? (await platform().files.read(orgId, id, "original"));
        // Images for item photos, PDFs because a receipt session's original is
        // often one - restricting to image/* silently dropped those.
        if (!f || !(f.mimeType.startsWith("image/") || f.mimeType === "application/pdf")) return;
        const bytes = Buffer.from(f.bytes);
        if (bytes.byteLength > EMBED_MAX_BYTES) return;
        map.set(id, { mime: f.mimeType, data: bytes.toString("base64") });
      } catch {
        /* unreadable → omit; export still succeeds */
      }
    }),
  );
  return (fileId) => {
    const e = map.get(fileId);
    return e ? { embed: e } : null;
  };
}

/** id → human name for this workspace's locations, so an export can carry WHERE
 *  an item was filed as a name. Read through the entities seam (never a direct
 *  query into another module's tables). Best-effort: no locations module, or a
 *  failure, just means the export omits the suggestion. */
async function locationNamer(orgId: string): Promise<(id: string) => string | null> {
  const byId = new Map<string, string>();
  try {
    const locs = await platform().entities.list(orgId, "core-locations:location", { limit: 2000 });
    for (const l of locs.items) {
      const name = l.title ?? String((l.fields as Record<string, unknown>)?.name ?? "");
      if (name) byId.set(String(l.id), name);
    }
  } catch {
    /* no locations to name → the export simply carries none */
  }
  return (id) => byId.get(id) ?? null;
}

const stamp = () => new Date().toISOString().slice(0, 10);

// The export modal's config: what photo mode to pre-select + the TTL choices.
exportRouter.get(
  "/export/options",
  asyncHandler(async (req, res) => {
    if (!requireRole(req, res, "owner", "admin", "member")) return;
    res.json({
      default_photo_mode: defaultPhotoMode(),
      ttl_choices: TTL_CHOICES.map((c) => ({ label: c.label, ms: c.ms })),
      default_ttl_ms: DEFAULT_TTL_MS,
    });
  }),
);

const PostBody = z.object({
  ids: z.array(z.string().min(1)).max(5000).optional(),
  status: z.enum(["all", "pending", "discarded"]).optional(),
  batch: z.string().min(1).optional(),
  photo_mode: z.enum(["link", "embed", "none"]).optional(),
  ttl_ms: z.number().int().min(MIN_TTL_MS).max(MAX_TTL_MS).optional(),
});

// The rich export the modal drives: an explicit selection + chosen photo mode.
exportRouter.post(
  "/export",
  asyncHandler(async (req, res) => {
    if (!requireRole(req, res, "owner", "admin", "member")) return;
    const parsed = PostBody.safeParse(req.body ?? {});
    if (!parsed.success) return badBody(res, parsed.error);
    const body = parsed.data;
    const ctx = tenantContext(req);
    const mode: PhotoMode = body.photo_mode ?? defaultPhotoMode();
    const ttlMs = body.ttl_ms ?? DEFAULT_TTL_MS;
    const { rows, batches, status, batchId } = await loadRows(req, {
      status: body.status,
      batchId: body.batch ?? null,
      ids: body.ids ?? null,
    });
    const resolve: PhotoResolver =
      mode === "embed"
        ? await embedResolver(ctx.org.id, rows, batches)
        : mode === "none"
          ? () => null
          : linkResolver(req, ctx.org.id, ttlMs);
    const env = buildEnvelope(rows, resolve, {
      sourceInstance: baseUrl(req),
      exportedAt: new Date().toISOString(),
      status,
      batchId,
      batches,
      locationName: await locationNamer(ctx.org.id),
    });
    res.setHeader("Content-Type", "application/json");
    res.setHeader("Content-Disposition", `attachment; filename="cobblr-scan-${status}-${stamp()}.json"`);
    res.send(JSON.stringify(env, null, 2));
  }),
);

exportRouter.get(
  "/export",
  asyncHandler(async (req, res) => {
    if (!requireRole(req, res, "owner", "admin", "member")) return;
    const ctx = tenantContext(req);
    const { rows, batches, status, batchId } = await loadRows(req);
    // Legacy GET keeps link photos at the default TTL (the modal's POST is where
    // embed / selection / custom TTL live).
    const env = buildEnvelope(rows, linkResolver(req, ctx.org.id, DEFAULT_TTL_MS), {
      sourceInstance: baseUrl(req),
      exportedAt: new Date().toISOString(),
      status,
      batchId,
      batches,
      locationName: await locationNamer(ctx.org.id),
    });
    res.setHeader("Content-Type", "application/json");
    res.setHeader("Content-Disposition", `attachment; filename="cobblr-scan-${status}-${stamp()}.json"`);
    res.send(JSON.stringify(env, null, 2));
  }),
);

exportRouter.get(
  "/export.csv",
  asyncHandler(async (req, res) => {
    if (!requireRole(req, res, "owner", "admin", "member")) return;
    const ctx = tenantContext(req);
    const { rows, status } = await loadRows(req);
    const base = baseUrl(req);
    const csv = buildCsv(rows, (fileId) => `${base}/api/v1/public/scan-export/${signExportToken(ctx.org.id, fileId, DEFAULT_TTL_MS)}/files/${fileId}/raw`);
    res.setHeader("Content-Type", "text/csv");
    res.setHeader("Content-Disposition", `attachment; filename="cobblr-scan-${status}-${stamp()}.csv"`);
    res.send(csv);
  }),
);
