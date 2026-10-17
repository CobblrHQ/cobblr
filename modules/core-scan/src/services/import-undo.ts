// Whether a scan import can still be undone (#7150, found by the #7110
// review). Undo deletes the rows the import made and writes back the rows it
// replaced, as they were. That is right only while those rows are as the
// import left them: a row filed since has a record in another module that the
// Undo does not touch, so writing the row back as pending offered the arrival
// again beside its stock, and filing it made a second record. The same for a
// row combined, split, put onto a bin or edited since. Undo then refuses and
// names the row, so the person deals with it through its own operation first.

/** History actions a heal writes, not a person (scan-history.ts). */
const HEALS = new Set(["store-code", "prose-name", "label-name", "label-cleared"]);

export interface ImportedRowNow {
  id: string;
  status: string;
  suggested_name: string | null;
  suggested_metadata: unknown;
}

export interface ImportUndoBlocker {
  id: string;
  name: string | null;
  why: "filed" | "deleted" | "combined" | "split" | "changed";
}

/** The first row the import touched that has moved on since `importedAt`,
 *  or null when Undo may run. A row that is gone blocks nothing. Pure. */
export function importUndoBlocker(rows: readonly ImportedRowNow[], importedAt: Date): ImportUndoBlocker | null {
  for (const r of rows) {
    const meta = (r.suggested_metadata ?? {}) as Record<string, unknown>;
    const name = r.suggested_name ?? null;
    if (r.status === "resolved" || meta.attached_to || meta.filed_into) return { id: r.id, name, why: "filed" };
    if (typeof meta.combined_into === "string" || Number(meta.merged_count) >= 2) return { id: r.id, name, why: "combined" };
    if (Array.isArray(meta.split_into) || typeof meta.split_from === "string") return { id: r.id, name, why: "split" };
    if (r.status === "discarded") return { id: r.id, name, why: "deleted" };
    // A person's change since the import; a heal's re-judging of a name is
    // the scan's own housekeeping, not an edit Undo would wipe.
    const history = Array.isArray(meta.history) ? (meta.history as Array<{ at?: unknown; action?: unknown }>) : [];
    if (history.some((h) => typeof h.at === "string" && !HEALS.has(String(h.action)) && new Date(h.at).getTime() > importedAt.getTime())) return { id: r.id, name, why: "changed" };
  }
  return null;
}

const WHY: Record<ImportUndoBlocker["why"], string> = {
  filed: "was filed since, and its record would stay while the scan came back",
  deleted: "was deleted since",
  combined: "was combined with another scan since",
  split: "was split since",
  changed: "was changed since",
};

/** The sentence Undo refuses with. Pure. */
export function importUndoRefusal(b: ImportUndoBlocker): string {
  return `"${b.name ?? "A scan from this import"}" ${WHY[b.why]}, so this import can no longer be undone as a whole. Undo that scan's own change first, or leave the import as it is.`;
}
