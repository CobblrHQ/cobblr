// How a scan in Recently deleted comes back, and the words for it.
//
// A combined row sat in Recently deleted with a plain Restore; pressing it
// said "Split the combined item instead", and the combined item had no Split
// anywhere (#3639). The refusal named an action the person could not reach.
// One rule now decides a deleted row's way back, and the server's refusal and
// the row's button both read it, so a refusal can only name the action the
// row offers. Every refusal in core-scan that names an action takes its words
// from SCAN_UNDO_ACTIONS; a test holds that each of those labels is on screen.

/** The labels of the actions a refusal may send someone to. The buttons
 *  render these same strings. */
export const SCAN_UNDO_ACTIONS = {
  restore: "Restore",
  undoCombine: "Undo combine",
  undoSplit: "Undo split",
  sendBack: "Send back",
} as const;

export type ScanDeletedRecovery =
  /** An ordinary discard: Restore puts it back where it was. */
  | { kind: "restore" }
  /** Combined into another scan: its quantity lives there, so the way back is
   *  undoing the combine, which returns both rows. */
  | { kind: "undo_combine"; into: string }
  /** A piece of a split that was undone: the group photo is back in the inbox
   *  and holds it. There is no button on this row; the group photo is the row. */
  | { kind: "in_group_photo"; from: string | null };

export function scanDeletedRecovery(meta: Record<string, unknown> | null | undefined): ScanDeletedRecovery {
  const m = meta ?? {};
  if (m.split_undone_at) return { kind: "in_group_photo", from: typeof m.split_from === "string" ? m.split_from : null };
  if (typeof m.combined_into === "string" && m.combined_into) return { kind: "undo_combine", into: m.combined_into };
  return { kind: "restore" };
}

/** Why Restore does not apply to this row, naming what does; null when it does. */
export function scanRestoreRefusal(r: ScanDeletedRecovery): string | null {
  if (r.kind === "undo_combine") {
    return `This scan was combined into another one, and its quantity lives there now. Press ${SCAN_UNDO_ACTIONS.undoCombine} to get both scans back as they were.`;
  }
  if (r.kind === "in_group_photo") {
    return "This scan came from a split that was undone: the group photo is back in the inbox and holds it.";
  }
  return null;
}

/** How many scans this kept row holds from a combine, or 0: the kept row's
 *  side of Undo combine. */
export function scanCombinedCount(meta: Record<string, unknown> | null | undefined): number {
  const n = Number((meta ?? {}).merged_count);
  return Number.isFinite(n) && n >= 2 ? n : 0;
}

/** Why a scan row may not be filed (Confirm, File into a bin, the
 *  dashboard's Add), or null when it may: the ONE rule filing and Restore
 *  share (#7144). A row already filed is done. A discarded row is not
 *  filed while discarded: one combined into another scan, or a part of a
 *  split that was undone, holds nothing of its own (its quantity lives in
 *  the row that absorbed it, and filing it counted it twice); any other
 *  deleted scan is restored first, so filing it is a choice made in view. */
export function scanFilingRefusal(row: { status: string; suggested_metadata?: unknown }): { code: string; message: string } | null {
  if (row.status === "resolved") return { code: "already_resolved", message: "This item was already confirmed." };
  if (row.status === "discarded") {
    const elsewhere = scanRestoreRefusal(scanDeletedRecovery((row.suggested_metadata ?? null) as Record<string, unknown> | null));
    if (elsewhere) return { code: "contents_elsewhere", message: elsewhere };
    return { code: "discarded", message: "This scan was deleted. Restore it from Recently deleted to file it." };
  }
  return null;
}
