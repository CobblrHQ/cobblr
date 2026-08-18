// Per-workspace custom label sizes (migration 0005). A size is DIMENSIONS: a
// media sheet and a label, both in inches. The col x row grid is derived
// (deriveGrid), never stored, so "a 1.5 x 3 sheet holding two 1.5in squares" is
// two measurements. See docs/design-decisions/label-media-and-accumulation.md.

import { Router } from "express";
import { z } from "zod";
import { deriveGrid } from "../label-sizes.js";
import { tenantDb, sessionUser } from "../db.js";
import { asyncHandler, badBody, requireRole } from "./util.js";

export const sizesRouter = Router({ mergeParams: true });

// Inches. Generous bounds: a 100in roll is fine, a 0 is not.
const dim = z.number().positive().max(100);
const gap = z.number().min(0).max(100);

const SizeBody = z.object({
  name: z.string().trim().min(1).max(120),
  media_w: dim,
  media_h: dim,
  label_w: dim,
  label_h: dim,
  margin_t: gap.default(0),
  margin_l: gap.default(0),
  col_gap: gap.default(0),
  row_gap: gap.default(0),
});

interface SizeRow {
  id: string;
  name: string;
  media_w: string;
  media_h: string;
  label_w: string;
  label_h: string;
  margin_t: string;
  margin_l: string;
  col_gap: string;
  row_gap: string;
}

/** Row (numeric-as-string) → API shape with the grid + per-sheet count derived. */
function present(row: SizeRow) {
  const n = (v: string) => Number(v);
  const dims = {
    media_w: n(row.media_w),
    media_h: n(row.media_h),
    label_w: n(row.label_w),
    label_h: n(row.label_h),
    margin_t: n(row.margin_t),
    margin_l: n(row.margin_l),
    col_gap: n(row.col_gap),
    row_gap: n(row.row_gap),
  };
  const grid = deriveGrid({ paper_w: dims.media_w, paper_h: dims.media_h, ...dims });
  return { id: row.id, name: row.name, ...dims, ...grid, per_sheet: grid.cols * grid.rows };
}

const COLS = ["id", "name", "media_w", "media_h", "label_w", "label_h", "margin_t", "margin_l", "col_gap", "row_gap"] as const;

sizesRouter.get(
  "/",
  asyncHandler(async (req, res) => {
    const rows = await tenantDb(req)
      .selectFrom("labels_custom_sizes")
      .select(COLS as unknown as string[] as never)
      .orderBy("created_at", "asc")
      .execute();
    res.json({ items: (rows as unknown as SizeRow[]).map(present) });
  }),
);

// AI-REACH: workspace configuration; the assistant changes config only through a workspace-scoped action, so a route with no action stays a person's
sizesRouter.post(
  "/",
  asyncHandler(async (req, res) => {
    if (!requireRole(req, res, "owner", "admin", "member")) return;
    const parsed = SizeBody.safeParse(req.body);
    if (!parsed.success) return badBody(res, parsed.error);
    const d = parsed.data;
    // A label bigger than its media fits zero times: reject rather than store a
    // size that can never print.
    const grid = deriveGrid({ paper_w: d.media_w, paper_h: d.media_h, ...d });
    if (grid.cols < 1 || grid.rows < 1) {
      res.status(400).json({ error: "does_not_fit", detail: `a ${d.label_w}x${d.label_h}" label does not fit a ${d.media_w}x${d.media_h}" media with those margins` });
      return;
    }
    const row = await tenantDb(req)
      .insertInto("labels_custom_sizes")
      .values({ ...d, created_by_user_id: sessionUser(req).id } as never)
      .returning(COLS as unknown as string[] as never)
      .executeTakeFirstOrThrow();
    res.status(201).json(present(row as unknown as SizeRow));
  }),
);

// AI-REACH: workspace configuration; the assistant changes config only through a workspace-scoped action, so a route with no action stays a person's
sizesRouter.put(
  "/:id",
  asyncHandler(async (req, res) => {
    if (!requireRole(req, res, "owner", "admin", "member")) return;
    const parsed = SizeBody.safeParse(req.body);
    if (!parsed.success) return badBody(res, parsed.error);
    const d = parsed.data;
    const grid = deriveGrid({ paper_w: d.media_w, paper_h: d.media_h, ...d });
    if (grid.cols < 1 || grid.rows < 1) {
      res.status(400).json({ error: "does_not_fit" });
      return;
    }
    const row = await tenantDb(req)
      .updateTable("labels_custom_sizes")
      .set({ ...d, updated_at: new Date() } as never)
      .where("id", "=", req.params.id as never)
      .returning(COLS as unknown as string[] as never)
      .executeTakeFirst();
    if (!row) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    res.json(present(row as unknown as SizeRow));
  }),
);

// AI-REACH: destructive on a record with no undo path through the ledger; delete_record covers kinds that declare it
sizesRouter.delete(
  "/:id",
  asyncHandler(async (req, res) => {
    if (!requireRole(req, res, "owner", "admin", "member")) return;
    const r = await tenantDb(req)
      .deleteFrom("labels_custom_sizes")
      .where("id", "=", req.params.id as never)
      .executeTakeFirst();
    res.json({ deleted: Number(r.numDeletedRows ?? 0) });
  }),
);
