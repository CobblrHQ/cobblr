// Render a set of queue rows to a print-ready PDF — the shared core of the manual
// /render endpoint AND the server-side auto-flush (slice 2). Assigns each entity a
// human code, freezes printed prefixes, honours the per-kind QR-centre overlay, and
// lays the labels onto the chosen size (built-in or custom:<id>) via renderLabelsPdf.
// Kept req-agnostic (takes the resolved QR `base`, not a Request) so a background
// dispatch can call it too.

import type { Kysely } from "kysely";
import type { LabelsDB } from "../db.js";
import { liveQrUrl } from "../live-qr-url.js";
import { renderLabelsPdf, type PrintItem } from "./pdf.js";
import { buildCustomLabelSheet, type LabelSheet } from "./layout.js";
import { assignCodes, freezePrintedGroups, getOverlayCenter } from "../services/codes.js";

/** A queue row, or a snapshot of one, that the renderer needs. */
export interface RenderableRow {
  module_name: string;
  entity_type: string;
  entity_id: string;
  qr_payload: string;
  description: string;
  qty: number;
}

/** Resolve a workspace-defined size (`custom:<id>`) to the LabelSheet the renderer
 *  wants, or null for a built-in key (the renderer looks those up itself). */
export async function customSheetFor(db: Kysely<LabelsDB>, sizeKey: string): Promise<LabelSheet | null> {
  if (!sizeKey.startsWith("custom:")) return null;
  const id = sizeKey.slice("custom:".length);
  const row = await db
    .selectFrom("labels_custom_sizes")
    .select(["id", "name", "media_w", "media_h", "label_w", "label_h", "margin_t", "margin_l", "col_gap", "row_gap"])
    .where("id", "=", id as never)
    .executeTakeFirst();
  if (!row) return null;
  const r = row as unknown as Record<string, string>;
  return buildCustomLabelSheet({
    id: r.id!,
    name: r.name!,
    media_w: Number(r.media_w),
    media_h: Number(r.media_h),
    label_w: Number(r.label_w),
    label_h: Number(r.label_h),
    margin_t: Number(r.margin_t),
    margin_l: Number(r.margin_l),
    col_gap: Number(r.col_gap),
    row_gap: Number(r.row_gap),
  });
}

export interface RenderedRows {
  pdf: Buffer;
  sheets: unknown;
  warnings: unknown;
  /** Total label count after qty expansion. */
  labels: number;
}

/** Rows → a PDF for `sizeKey`. Expands each row by qty; the code/overlay/freeze
 *  side-effects match the manual print path exactly (these labels ARE being
 *  printed). `base` is the resolved QR base URL. */
export async function renderRowsToPdf(
  db: Kysely<LabelsDB>,
  orgId: string,
  base: string | null,
  rows: RenderableRow[],
  sizeKey: string,
): Promise<RenderedRows> {
  const printRefs = rows.map((r) => ({ kind: `${r.module_name}:${r.entity_type}`, id: r.entity_id }));
  const codes = await assignCodes(orgId, db, printRefs);
  // A PDF the user is about to put on paper counts as printing: lock these prefixes.
  await freezePrintedGroups(db, printRefs);
  const overlay = await getOverlayCenter(db, rows.map((r) => `${r.module_name}:${r.entity_type}`));
  const items: PrintItem[] = [];
  rows.forEach((r, i) => {
    const overlayOn = overlay.get(`${r.module_name}:${r.entity_type}`) ?? true;
    const centerCode = overlayOn ? codes.get(r.entity_id) : undefined;
    for (let n = 0; n < (r.qty ?? 1); n++) {
      items.push({ kind: r.entity_type, id: i + 1, title: r.description, url: liveQrUrl(r.qr_payload, base), centerCode });
    }
  });
  const custom = await customSheetFor(db, sizeKey);
  const out = await renderLabelsPdf({ size_key: sizeKey, items, ...(custom ? { extraSizes: [custom] } : {}) });
  return { pdf: out.pdf, sheets: out.sheets, warnings: out.warnings, labels: items.length };
}
