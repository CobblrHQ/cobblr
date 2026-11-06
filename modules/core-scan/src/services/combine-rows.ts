// Folding inbox rows into one, with the way back (#3639). One implementation
// behind the person's Combine and the heal of a receipt's repeated lines (#9268).

import { sql, type Kysely, type Selectable } from "kysely";
import { countOf } from "@cobblr/platform-contract";
import type { CoreScanDB } from "../db.js";
import { isMachineReadCode } from "./barcode-source.js";
import { combinedQuantityOf, unionCandidateFields, type CombineItem } from "./combine-merge.js";
import { filedQuantityOf } from "./filed-quantity.js";
import { mergeMeta } from "./metadata.js";
import { addAmounts } from "./same-receipt-lines.js";
import { appendScanHistory } from "./scan-history.js";
import type { CombineUndo } from "./uncombine.js";

export type InboxRow = Selectable<CoreScanDB["core_scan_inbox_items"]>;

const metaOf = (r: Pick<InboxRow, "suggested_metadata">) => (r.suggested_metadata ?? {}) as Record<string, unknown>;
const moneyIn = (m: Record<string, unknown>, key: string) => (typeof m[key] === "number" ? (m[key] as number) : null);

/** What lines of one receipt add up to, on the row that now stands for them,
 *  and the lines themselves. Null where no line had that figure. */
function lineFiguresOf(rows: readonly InboxRow[]): Record<string, unknown> {
  const metas = rows.map(metaOf);
  const sum = (read: (m: Record<string, unknown>) => number | null) => metas.reduce<number | null>((total, m) => addAmounts(total, read(m)), null);
  const anyDiscounted = metas.some((m) => moneyIn(m, "line_net") !== null);
  return {
    line_total: metas.every((m) => moneyIn(m, "line_total") !== null) ? sum((m) => moneyIn(m, "line_total")) : null,
    line_discount: sum((m) => moneyIn(m, "line_discount")),
    order_discount_share: sum((m) => moneyIn(m, "order_discount_share")),
    line_net: anyDiscounted ? sum((m) => moneyIn(m, "line_net") ?? moneyIn(m, "line_total")) : null,
    source_lines: rows.map((r, i) => ({
      qty: filedQuantityOf(r.quantity),
      line_total: moneyIn(metas[i]!, "line_total"),
      discount: moneyIn(metas[i]!, "line_discount"),
      order_discount: moneyIn(metas[i]!, "order_discount_share"),
    })),
  };
}

/** The kept row takes the summed quantity and fills its gaps from the others,
 *  which leave the inbox pointing at it (`combined_into`), so Undo combine
 *  returns every row as it was. `lineFigures`: the rows are lines of one receipt,
 *  so what they cost adds up too. */
export async function combineInboxRows(
  db: Kysely<CoreScanDB>,
  rows: readonly InboxRow[],
  primaryId: string,
  opts: { unique?: boolean; lineFigures?: boolean } = {},
): Promise<void> {
  const primary = rows.find((r) => r.id === primaryId) ?? rows[0];
  if (!primary) return;
  const others = rows.filter((r) => r.id !== primary.id);
  // UNION the fields: the primary keeps its own values and fills its GAPS from the
  // others (same table only). So merging a plate photo into a VIN vehicle carries
  // the colour + plate across instead of discarding them.
  const unionedCandidates = unionCandidateFields(primary as unknown as CombineItem, others as unknown as CombineItem[]);
  // A case label beside one of its items is the case's count (#3729).
  const totalQty = combinedQuantityOf(rows.map((r) => ({ quantity: filedQuantityOf(r.quantity), barcode_text: r.barcode_text })), opts.unique === true);
  const barcodes = Array.from(new Set(rows.map((r) => r.barcode_text).filter(Boolean))) as string[];
  const meta = metaOf(primary);
  // Barcode authority: if the kept item's own barcode was READ BY AI (OCR, can
  // be a digit off) — or it has none — but a merged item carries a SCANNED one,
  // adopt the scanned code as the kept item's barcode. So you keep the photo +
  // name you chose AND end up with the real barcode. Clear the ai-photo flag.
  const primaryAiBarcode = isMachineReadCode((meta as { barcode_source?: string }).barcode_source);
  const scannedBarcode = others.find((o) => o.barcode_text && !isMachineReadCode((metaOf(o) as { barcode_source?: string }).barcode_source))?.barcode_text;
  const adoptBarcode = (primaryAiBarcode || !primary.barcode_text) && scannedBarcode ? scannedBarcode : null;
  // Never lose the user's real photo on a merge: if the kept item has no photo
  // of its own but a merged one does, carry it over (e.g. "keep the scanned
  // listing" still keeps the picture you took).
  const adoptPhoto = !primary.image_file_id ? others.find((o) => o.image_file_id)?.image_file_id ?? null : null;
  const figures = opts.lineFigures ? lineFiguresOf(rows) : null;
  const figureSet = figures ? Object.fromEntries(Object.entries(figures).filter(([, v]) => v !== null)) : {};
  await db
    .updateTable("core_scan_inbox_items")
    .set({
      quantity: totalQty,
      ...(adoptBarcode ? { barcode_text: adoptBarcode } : {}),
      ...(adoptPhoto ? { image_file_id: adoptPhoto } : {}),
      ...(unionedCandidates ? { suggested_candidates: JSON.stringify(unionedCandidates) as never } : {}),
      suggested_metadata: mergeMeta(
        {
          ...figureSet,
          ...(barcodes.length ? { merged_barcodes: barcodes } : {}),
          merged_count: rows.length,
          // What Undo combine gives back (#3639), from either row.
          combine_undo: {
            absorbed: others.map((o) => o.id),
            quantity_before: filedQuantityOf(primary.quantity),
            quantity_after: totalQty,
            barcode_before: primary.barcode_text,
            barcode_after: adoptBarcode ?? primary.barcode_text,
            image_before: primary.image_file_id,
            image_after: adoptPhoto ?? primary.image_file_id,
            candidates_before: primary.suggested_candidates ?? [],
            candidates_after: unionedCandidates ?? primary.suggested_candidates ?? [],
            merged_barcodes_before: meta.merged_barcodes ?? null,
            merged_count_before: meta.merged_count ?? null,
            ...(figures
              ? { figures_before: Object.fromEntries(Object.keys(figures).map((k) => [k, meta[k] ?? null])), figures_after: figures }
              : {}),
            previous: (meta.combine_undo as CombineUndo | undefined) ?? null,
          } satisfies CombineUndo,
        },
        // Adopting a merged item's barcode means its AI-photo-read barcode_source
        // no longer applies — drop it (what metaNoSource used to do by omission).
        adoptBarcode ? ["barcode_source"] : [],
      ) as never,
      updated_at: new Date(),
    })
    .where("id", "=", primary.id)
    .execute();
  // Losers carry a marker: their quantities were SUMMED into the primary, so
  // restoring one alone would double-count. Their way back is Undo combine
  // (scan-recovery.ts), which returns both rows.
  await db
    .updateTable("core_scan_inbox_items")
    .set({
      status: "discarded",
      suggested_metadata: sql`coalesce(suggested_metadata, '{}'::jsonb) || jsonb_build_object('combined_into', ${primary.id}::text)` as never,
      updated_at: new Date(),
    })
    .where("id", "in", others.map((o) => o.id))
    .execute();
  await appendScanHistory(db, primary.id, { action: "combine", note: `${countOf(rows.length, "item")}` });
}

/** The order lines of rows folded into this one: filing the row files them too,
 *  or the purchase reads them as still waiting for a thing. Their rows carry
 *  their own claim (receipt-purchase.ts stamps every row of a read). */
export async function absorbedOrderLines(db: Kysely<CoreScanDB>, rowId: string): Promise<Array<{ orderId: string; lineId: string }>> {
  const rows = await db
    .selectFrom("core_scan_inbox_items")
    .select("suggested_metadata")
    .where(sql<string>`suggested_metadata ->> 'combined_into'`, "=", rowId)
    .where("status", "=", "discarded")
    .execute();
  return rows.flatMap((r) => {
    const m = metaOf(r);
    return typeof m.receipt_order_id === "string" && typeof m.receipt_order_item_id === "string" ? [{ orderId: m.receipt_order_id, lineId: m.receipt_order_item_id }] : [];
  });
}
