// Scan-inbox bulk EXPORT — the mirror of api/import.ts. Emits the workspace's
// scan inbox in the INBOX_EXPORT_INTEROP v1 envelope (JSON or CSV), so it
// round-trips straight back into another Cobblr (or an external system) via the
// importer — no DB surgery. Photo URLs point at the no-auth, token-gated
// image route so the importer's best-effort photo fetch carries the images.
//
//   GET /export            → JSON envelope   (?status=all|pending|discarded, ?batch=<id>)
//   GET /export.csv        → flattened CSV    (same filters)

import { Router } from "express";
import type { Request } from "express";
import { tenantContext, tenantDb } from "../db.js";
import { asyncHandler, requireRole } from "./util.js";
import { buildEnvelope, buildCsv, type ScanRowForExport } from "../services/export.js";
import { signExportToken } from "../services/export-token.js";

export const exportRouter = Router({ mergeParams: true });

/** The instance origin to build absolute photo URLs against: an
 *  `x-cobblr-base-url` override (isolated-stack e2e), else the request's own
 *  forwarded proto + host. Same precedence core-labels-qr uses. */
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
  "created_at", "updated_at",
] as const;

async function loadRows(req: Request): Promise<{ rows: ScanRowForExport[]; status: string; batchId: string | null }> {
  const db = tenantDb(req);
  const statusQ = typeof req.query.status === "string" ? req.query.status : "all";
  const batchId = typeof req.query.batch === "string" && req.query.batch ? req.query.batch : null;
  let q = db.selectFrom("core_scan_inbox_items").select(EXPORT_COLS as unknown as (typeof EXPORT_COLS)[number][]);
  if (statusQ !== "all") q = q.where("status", "=", statusQ as never);
  if (batchId) q = q.where("scan_batch_id", "=", batchId);
  const rows = (await q.orderBy("created_at", "asc").execute()) as unknown as ScanRowForExport[];
  return { rows, status: statusQ, batchId };
}

/** A photoUrl(fileId) closure over a freshly-minted, org-scoped export token. */
function photoUrlFactory(req: Request, orgId: string): (fileId: string) => string {
  const base = baseUrl(req);
  const token = signExportToken(orgId);
  return (fileId: string) => `${base}/api/v1/public/scan-export/${token}/files/${fileId}/raw`;
}

const stamp = () => new Date().toISOString().slice(0, 10);

exportRouter.get(
  "/export",
  asyncHandler(async (req, res) => {
    if (!requireRole(req, res, "owner", "admin", "member")) return;
    const ctx = tenantContext(req);
    const { rows, status, batchId } = await loadRows(req);
    const env = buildEnvelope(rows, photoUrlFactory(req, ctx.org.id), {
      sourceInstance: baseUrl(req),
      exportedAt: new Date().toISOString(),
      status,
      batchId,
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
    const csv = buildCsv(rows, photoUrlFactory(req, ctx.org.id));
    res.setHeader("Content-Type", "text/csv");
    res.setHeader("Content-Disposition", `attachment; filename="cobblr-scan-${status}-${stamp()}.csv"`);
    res.send(csv);
  }),
);
