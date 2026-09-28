// The lot printed beside a barcode, read off the scan's own frame.
//
// On a skein of yarn (and a tin of food, a spool of filament) the lot is
// printed right next to the barcode the camera just decoded, so the frame the
// scan kept already shows it. Nothing read it: the frame went only to the
// barcode-vs-photo cross-check, whose answer had no lot, and the label reader
// ran only on photos added afterwards (#3792).
//
// Read here with the OCR engine, no model, in the background. Only the lot is
// taken from a barcode scan's frame: the frame shows one unit, and a count or
// a colour printed near the code is the product's catalogue business. The
// cross-check, when it runs, adds what its own vision call saw printed
// (enrich-photo.ts), in the call it was making anyway.

import type { Kysely } from "kysely";
import { platform } from "@cobblr/platform-contract";
import { ocrImageText } from "./ocr.js";
import { labelFactsOf, yearMadeOf } from "./label-facts.js";
import { applyLabelFacts } from "./label-quantity.js";

interface FrameDB {
  core_scan_inbox_items: { id: string; image_file_id: string | null };
}

/** Write a lot to a pending row as read from its label, the person's own lot
 *  left alone. Only the lot: `""` stops applyLabelFacts reading anything else. */
export function applyLabelLot(db: Parameters<typeof applyLabelFacts>[0], itemId: string, lot: string | null | undefined) {
  const clean = typeof lot === "string" ? lot.trim() : "";
  if (!clean || !/\d/.test(clean) || clean.length > 24) return Promise.resolve(null);
  return applyLabelFacts(db, itemId, "", { lot: clean });
}

/** Write the year a unit was made to a pending row, as read from its label,
 *  the person's own year left alone. Only the year, like applyLabelLot. */
export function applyLabelYearMade(db: Parameters<typeof applyLabelFacts>[0], itemId: string, year: unknown) {
  const clean = yearMadeOf(year);
  if (!clean) return Promise.resolve(null);
  return applyLabelFacts(db, itemId, "", { year_made: clean });
}

/** Read the lot off a barcode scan's frame. A no-op without a frame, without
 *  the OCR engine, or when the frame shows no lot. */
export async function readScanFrameLot(orgId: string, itemId: string): Promise<string | null> {
  const db = (await platform().tenants.getDb(orgId)) as unknown as Kysely<FrameDB>;
  const row = await db.selectFrom("core_scan_inbox_items").select(["image_file_id"]).where("id", "=", itemId).executeTakeFirst();
  if (!row?.image_file_id) return null;
  const file = await platform().files.read(orgId, row.image_file_id, "original");
  if (!file) return null;
  const text = (await ocrImageText(new Uint8Array(file.bytes)))?.text;
  const lot = labelFactsOf(text).lot ?? null;
  if (lot) await applyLabelLot(db as never, itemId, lot);
  return lot;
}
