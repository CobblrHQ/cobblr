// Whether the ↺ "rerun lookup" can do anything for an inbox item. Re-run re-does
// the identify/enrich, which needs SOMETHING to look up again: a barcode, a photo,
// OR a name. A receipt/note line has only a NAME — re-running re-does the web/text
// search and can finally fetch a product image + re-identify. Gating on
// barcode||image ONLY wrongly greyed out every receipt line (2026-07-24).
export function canRerunLookup(item: {
  barcode_text?: string | null;
  image_file_id?: string | null;
  suggested_name?: string | null;
}): boolean {
  return Boolean(item.barcode_text || item.image_file_id || item.suggested_name);
}
