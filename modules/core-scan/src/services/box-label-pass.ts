// A photo of a box's own label, read with no model (#5764). A filament box
// prints its line, colour, SKU and batch; the open order says what can be
// arriving. Read off the photo by OCR and settled against the order's open
// lines and pack parts, the scan is named and counted before any model is
// asked: a line of the same thing takes it as one of its units (at the end of
// the scan's match, orderLinePass), a pack's part takes its box's batch.
// What the label cannot settle goes to the usual photo identify, never a
// guess.

import { sql, type Kysely } from "kysely";
import { boxFromReadings, skuCore, storeChoices, type BoxChoice } from "@cobblr/platform-contract/box-label";
import { storeVariantOf } from "@cobblr/platform-contract/same-product";
import { lineTakesAUnit, lineUnitsOf } from "@cobblr/platform-contract/line-units";
import { FIELD_PROVENANCE_KEY, fieldProvenanceOf } from "@cobblr/platform-contract/acquisition-source";
import type { CoreScanDB } from "../db.js";
import { mergeMeta } from "./metadata.js";
import { ocrLabelReadings } from "./ocr.js";

/** An open order row a box can be: a line of the same thing with a slot free,
 *  or one part of a split pack, not yet confirmed by its box. */
export interface OpenOrderRow {
  id: string;
  suggested_name: string | null;
  suggested_manufacturer?: string | null;
  quantity: number | string | null;
  suggested_metadata: unknown;
}

export interface SettledBox {
  row: OpenOrderRow;
  choice: BoxChoice;
  /** "line": one of a line's units; "part": the pack part itself. */
  as: "line" | "part";
  batch: string | null;
  line: string | null;
}

type RowMeta = {
  pack_colour?: unknown;
  pack_unit?: { label_colour?: unknown; sku?: unknown };
  store_product?: { variant?: unknown; photo?: unknown };
  store_line_image?: unknown;
  split_from?: unknown;
  box_scan?: unknown;
  line_received?: unknown;
};

const metaOf = (r: OpenOrderRow) => (r.suggested_metadata ?? {}) as RowMeta;
const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);

/** What the row's box would print: the colour it was bought in, the colour
 *  its box says when a known pack said so, and its SKU (the pack's, or the
 *  store's variant photo's file name). */
export function rowChoice(r: OpenOrderRow): BoxChoice | null {
  const m = metaOf(r);
  const colour = str(m.pack_colour) ?? storeVariantOf(r.suggested_name)?.options.at(-1) ?? null;
  if (!colour) return null;
  const photo = str(m.store_product?.photo) ?? str(m.store_line_image);
  const fromPhoto = photo ? storeChoices([{ colour, photo }])[0]!.sku ?? null : null;
  return { colour, label_colour: str(m.pack_unit?.label_colour), sku: str(m.pack_unit?.sku) ?? fromPhoto };
}

/** Whether a row can still take a box: a same-thing line with a slot free,
 *  or a pack part no box has confirmed. */
function takes(r: OpenOrderRow): "line" | "part" | null {
  const m = metaOf(r);
  const units = lineUnitsOf(r);
  if (units) return lineTakesAUnit(units, Number(m.line_received ?? 0)) ? "line" : null;
  return m.split_from && !m.box_scan ? "part" : null;
}

/** The product line's material word ("PETG Basic" is PETG): a box of one
 *  material is never a line of another. */
const materialOf = (line: string | null) => line?.split(" ")[0]?.toLowerCase() ?? null;
const saysMaterial = (name: string | null, material: string) => new RegExp(`(^|[^a-z])${material.replace("+", "\\+")}([^a-z]|$)`, "i").test(name ?? "");

/** Which open row the box is, from two readings of its label. Pure. Rows
 *  that print the same box are one choice; a line with a slot free is filled
 *  before a pack part of the same colour. Null when the label does not settle
 *  it. */
export function settleBox(frame: string | null | undefined, fine: string | null | undefined, rows: readonly OpenOrderRow[]): SettledBox | null {
  const open = rows.map((r) => ({ r, as: takes(r), choice: rowChoice(r) })).filter((x): x is { r: OpenOrderRow; as: "line" | "part"; choice: BoxChoice } => !!x.as && !!x.choice);
  if (open.length === 0) return null;
  // One choice per thing a box can print: the store's colour and its SKU. A
  // carton line and a pack's part of the same white are one choice, which
  // takes the box's printed colour from whichever row knows it.
  const key = (c: BoxChoice) => `${c.colour.toLowerCase()}|${skuCore(c.sku)}`;
  const byKey = new Map<string, { choice: BoxChoice; rows: typeof open }>();
  for (const o of open) {
    const k = key(o.choice);
    const g = byKey.get(k) ?? { choice: { ...o.choice }, rows: [] };
    g.choice.label_colour ??= o.choice.label_colour ?? null;
    g.choice.sku ??= o.choice.sku ?? null;
    g.rows.push(o);
    byKey.set(k, g);
  }
  const groups = [...byKey.values()];
  const first = boxFromReadings(frame, fine, groups.map((g) => g.choice));
  const material = materialOf(first.line);
  // The box's own material narrows what it can be, when it printed one.
  const narrowed = material ? groups.filter((g) => g.rows.some((o) => saysMaterial(o.r.suggested_name, material))) : groups;
  const read = material && narrowed.length !== groups.length ? boxFromReadings(frame, fine, narrowed.map((g) => g.choice)) : first;
  if (!read.choice) return null;
  const group = narrowed.find((g) => g.choice === read.choice);
  if (!group) return null;
  const pick = group.rows.find((o) => o.as === "line") ?? group.rows[0]!;
  return { row: pick.r, choice: group.choice, as: pick.as, batch: read.batch, line: read.line };
}

/** The open order rows a box could be. */
export async function openOrderRows(db: Kysely<CoreScanDB>): Promise<OpenOrderRow[]> {
  return (await db
    .selectFrom("core_scan_inbox_items")
    .select(["id", "suggested_name", "suggested_manufacturer", "quantity", "suggested_metadata"])
    .where("source_kind", "=", "receipt")
    .where("status", "=", "pending")
    .where("created_at", ">", sql<Date>`now() - interval '180 days'`)
    .where(sql<boolean>`(suggested_metadata ? 'store_product' or suggested_metadata ? 'pack_unit' or suggested_metadata ? 'store_line_image')`)
    .orderBy("created_at", "desc")
    .limit(300)
    .execute()) as OpenOrderRow[];
}

export type BoxReadings = (bytes: Buffer | Uint8Array) => Promise<{ frame: string; fine: string } | null>;

/** Read a scan's photo as a box label and settle it against the open order.
 *  "line": named as the line's thing, its slot filled at the end of its
 *  match. "part": the pack part takes the box's batch and the scan is done.
 *  "none": nothing settled; the photo goes to the usual identify. */
export async function boxLabelPass(db: Kysely<CoreScanDB>, itemId: string, bytes: Buffer | Uint8Array, read: BoxReadings = ocrLabelReadings): Promise<"line" | "part" | "none"> {
  const rows = await openOrderRows(db);
  // No open order a box could belong to: no OCR is spent.
  if (rows.length === 0) return "none";
  const readings = await read(bytes);
  if (!readings) return "none";
  const box = settleBox(readings.frame, readings.fine, rows);
  if (!box) return "none";
  const label = { colour: box.choice.label_colour ?? box.choice.colour, sku: box.choice.sku ?? null, batch: box.batch, line: box.line, row_id: box.row.id };
  const said = [label.colour, label.sku, label.batch ? `batch ${label.batch}` : "batch unread"].filter(Boolean).join(", ");
  const now = new Date();
  const at = now.toISOString();
  if (box.as === "part") {
    return db.transaction().execute(async (tx) => {
      const part = await tx.selectFrom("core_scan_inbox_items").select(["id", "status", "suggested_metadata"]).where("id", "=", box.row.id).forUpdate().executeTakeFirst();
      const pm = (part?.suggested_metadata ?? {}) as Record<string, unknown>;
      if (!part || part.status !== "pending" || pm.box_scan) return "none" as const;
      const stamps = fieldProvenanceOf(pm);
      const lotFromBox = box.batch && stamps.lot?.by !== "person" ? box.batch : null;
      await tx
        .updateTable("core_scan_inbox_items")
        .set({
          suggested_metadata: mergeMeta({
            box_scan: { scan_id: itemId, at, lot_before: typeof pm.lot === "string" ? pm.lot : null },
            ...(lotFromBox ? { lot: lotFromBox, [FIELD_PROVENANCE_KEY]: { ...stamps, lot: { by: "evidence", from: "label", at } } } : {}),
          }) as never,
          updated_at: now,
        })
        .where("id", "=", part.id)
        .execute();
      await tx
        .updateTable("core_scan_inbox_items")
        .set({
          status: "resolved",
          resolved_at: now,
          updated_at: now,
          suggested_name: box.row.suggested_name,
          ai_suggested_at: now,
          ai_notes: `Its box label says ${said}: it is ${box.row.suggested_name ?? "a part of the order"}, already on the order. No AI was asked.`,
          suggested_metadata: mergeMeta({ box_label: label, fills_part: part.id }, ["line_offer"]) as never,
        })
        .where("id", "=", itemId)
        .execute();
      return "part" as const;
    });
  }
  const scan = await db.selectFrom("core_scan_inbox_items").select("suggested_metadata").where("id", "=", itemId).executeTakeFirst();
  const stamps = fieldProvenanceOf(scan?.suggested_metadata);
  const lot = box.batch && stamps.lot?.by !== "person" ? box.batch : null;
  await db
    .updateTable("core_scan_inbox_items")
    .set({
      suggested_name: box.row.suggested_name,
      ...(box.row.suggested_manufacturer ? { suggested_manufacturer: box.row.suggested_manufacturer } : {}),
      ai_suggested_at: now,
      updated_at: now,
      ai_notes: `Read from its box label: ${said}. No AI was asked.`,
      suggested_metadata: mergeMeta({
        box_label: label,
        ...(lot ? { lot, [FIELD_PROVENANCE_KEY]: { ...stamps, lot: { by: "evidence", from: "label", at } } } : {}),
      }) as never,
    })
    .where("id", "=", itemId)
    .execute();
  return "line";
}
