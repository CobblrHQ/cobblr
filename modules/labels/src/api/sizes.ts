// Per-workspace custom label sizes (migration 0005). A size is DIMENSIONS: a
// media sheet and a label, both in inches. The col x row grid is derived
// (deriveGrid), never stored, so "a 1.5 x 3 sheet holding two 1.5in squares" is
// two measurements. See docs/design-decisions/label-media-and-accumulation.md.

import { Router } from "express";
import { z } from "zod";
import { deriveGrid } from "../label-sizes.js";
import { tenantDb, sessionUser } from "../db.js";
import { asyncHandler, badBody } from "./util.js";
import { requireCapability } from "@cobblr/platform-contract/action-gate";
import { withArticle } from "@cobblr/platform-contract/plural";

export const sizesRouter = Router({ mergeParams: true });

// Inches. Generous bounds: a 100in roll is fine, a 0 is not.
const dim = z.number().positive().max(100);
const gap = z.number().min(0).max(100);

export const SizeBody = z.object({
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

export type SizeInput = z.infer<typeof SizeBody>;

/** Insert or change a custom size; a label bigger than its media fits zero
 *  times, so it is refused rather than stored as a size that can never print. */
export async function writeSize(db: ReturnType<typeof tenantDb>, d: SizeInput, at: { id: string } | { userId: string }) {
  const grid = deriveGrid({ paper_w: d.media_w, paper_h: d.media_h, ...d });
  if (grid.cols < 1 || grid.rows < 1) return { error: `${withArticle(`${d.label_w}x${d.label_h}"`)} label does not fit ${withArticle(`${d.media_w}x${d.media_h}"`)} sheet.` };
  const row = "id" in at
    ? await db.updateTable("labels_custom_sizes").set({ ...d, updated_at: new Date() } as never).where("id", "=", at.id as never).returning(COLS as unknown as string[] as never).executeTakeFirst()
    : await db
        .insertInto("labels_custom_sizes")
        .values({
          name: d.name,
          media_w: String(d.media_w),
          media_h: String(d.media_h),
          label_w: String(d.label_w),
          label_h: String(d.label_h),
          margin_t: String(d.margin_t),
          margin_l: String(d.margin_l),
          col_gap: String(d.col_gap),
          row_gap: String(d.row_gap),
          created_by_user_id: at.userId,
        })
        .returning(COLS as unknown as string[] as never)
        .executeTakeFirstOrThrow();
  return row ? { size: present(row as unknown as SizeRow) } : null;
}

export async function removeSize(db: ReturnType<typeof tenantDb>, id: string) {
  const r = await db.deleteFrom("labels_custom_sizes").where("id", "=", id as never).executeTakeFirst();
  return Number(r.numDeletedRows ?? 0);
}

export async function listSizes(db: ReturnType<typeof tenantDb>) {
  const rows = await db.selectFrom("labels_custom_sizes").select(COLS as unknown as string[] as never).orderBy("created_at", "asc").execute();
  return (rows as unknown as SizeRow[]).map(present);
}

// AI-ACTION: labels:save-size
sizesRouter.post(
  "/",
  asyncHandler(async (req, res) => {
    if (!(await requireCapability(req, res, "labels:save-size"))) return;
    const parsed = SizeBody.safeParse(req.body);
    if (!parsed.success) return badBody(res, parsed.error);
    const out = await writeSize(tenantDb(req), parsed.data, { userId: sessionUser(req).id });
    if (out && "error" in out) return void res.status(400).json({ error: "does_not_fit", detail: out.error });
    res.status(201).json(out!.size);
  }),
);

// AI-ACTION: labels:save-size
sizesRouter.put(
  "/:id",
  asyncHandler(async (req, res) => {
    if (!(await requireCapability(req, res, "labels:save-size"))) return;
    const parsed = SizeBody.safeParse(req.body);
    if (!parsed.success) return badBody(res, parsed.error);
    const out = await writeSize(tenantDb(req), parsed.data, { id: String(req.params.id) });
    if (!out) return void res.status(404).json({ error: "not_found" });
    if ("error" in out) return void res.status(400).json({ error: "does_not_fit" });
    res.json(out.size);
  }),
);

// AI-ACTION: labels:remove-size
sizesRouter.delete(
  "/:id",
  asyncHandler(async (req, res) => {
    if (!(await requireCapability(req, res, "labels:remove-size"))) return;
    res.json({ deleted: await removeSize(tenantDb(req), String(req.params.id)) });
  }),
);
