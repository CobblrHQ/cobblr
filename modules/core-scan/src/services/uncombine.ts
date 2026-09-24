// Undoing a combine (#3639): the absorbed rows come back as they were and the
// kept row gives back what the combine added. What the person changed on the
// kept row since is theirs and stays: each value reverts only when it still
// reads what the combine wrote.

/** Written on the kept row at combine time. */
export interface CombineUndo {
  absorbed: string[];
  quantity_before: number;
  quantity_after: number;
  barcode_before: string | null;
  barcode_after: string | null;
  image_before: string | null;
  image_after: string | null;
  candidates_before: unknown;
  candidates_after: unknown;
  merged_barcodes_before: unknown;
  merged_count_before: unknown;
  /** The kept row's own earlier combine, so undoing this one leaves that one
   *  undoable in its turn. */
  previous: CombineUndo | null;
}

export interface KeptRow {
  quantity: number | string | null;
  barcode_text: string | null;
  image_file_id: string | null;
  suggested_candidates: unknown;
  suggested_metadata: unknown;
}

export interface UncombinePlan {
  set: { quantity: number; barcode_text?: string | null; image_file_id?: string | null; suggested_candidates?: string };
  metaSet: Record<string, unknown>;
  metaDrop: string[];
}

const qty = (v: unknown): number => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : 1;
};
const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/** `absorbedQuantities` covers a combine made before the snapshot existed:
 *  the kept row then gives back the sum of what it absorbed. */
export function uncombinePlan(kept: KeptRow, absorbedQuantities: number[]): UncombinePlan {
  const meta = (kept.suggested_metadata ?? {}) as { combine_undo?: CombineUndo };
  const u = meta.combine_undo;
  const now = qty(kept.quantity);
  const metaDrop = ["combine_undo", "merged_barcodes", "merged_count"];
  if (!u) {
    const added = absorbedQuantities.reduce((a, b) => a + qty(b), 0);
    return { set: { quantity: Math.max(1, now - added) }, metaSet: {}, metaDrop };
  }
  const added = qty(u.quantity_after) - qty(u.quantity_before);
  const set: UncombinePlan["set"] = { quantity: now === qty(u.quantity_after) ? qty(u.quantity_before) : Math.max(1, now - added) };
  if (u.barcode_after !== u.barcode_before && kept.barcode_text === u.barcode_after) set.barcode_text = u.barcode_before;
  if (u.image_after !== u.image_before && kept.image_file_id === u.image_after) set.image_file_id = u.image_before;
  if (!same(u.candidates_after, u.candidates_before) && same(kept.suggested_candidates, u.candidates_after)) {
    set.suggested_candidates = JSON.stringify(u.candidates_before ?? []);
  }
  const metaSet: Record<string, unknown> = {};
  if (u.previous) metaSet.combine_undo = u.previous;
  if (u.merged_barcodes_before != null) metaSet.merged_barcodes = u.merged_barcodes_before;
  if (u.merged_count_before != null) metaSet.merged_count = u.merged_count_before;
  return { set, metaSet, metaDrop: metaDrop.filter((k) => !(k in metaSet)) };
}
