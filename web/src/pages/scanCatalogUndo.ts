// What the catalog image's undo control should say, and whether to show it.
//
// Revert is undo over a stack of picks: the blind first web result, then maybe
// "✨ Pick best (AI)", then maybe one you chose. The button therefore cannot
// always read "↺ original" — after an AI pick, one press lands on the AI's
// photo, and calling that "original" is a lie about what is about to happen
// (reported 2026-08-11).
//
// Pure and unit-tested, the same shape as classifyOmni: the server owns the
// stack, this owns only how the next step is described. It lives in web because
// web must not import from a module (no such import exists anywhere in the
// tree), so the alternative was a second copy of the rule inside a component.

/** One earlier catalog image. `source` says what produced it. */
export interface CatalogUndoStep {
  url?: string | null;
  file_id?: string | null;
  source?: string;
}

/** Read the stack off an item's `suggested_metadata`, tolerating both shapes:
 *  the current `catalog_history` array, and an item that predates it carrying
 *  only the single `orig_catalog` stash (the server seeds a real stack from
 *  that on its next write, so this just has to keep the button visible). */
export function catalogUndoHistory(
  meta: { catalog_history?: unknown; orig_catalog?: unknown } | null | undefined,
): CatalogUndoStep[] {
  if (Array.isArray(meta?.catalog_history)) return meta.catalog_history as CatalogUndoStep[];
  return meta?.orig_catalog ? [{ source: "web" }] : [];
}

/** The control's label, or null when there is nothing to undo.
 *
 *  TEXT ONLY — the rotate glyph that used to be baked in here is now a real
 *  icon rendered beside it. A unicode symbol standing in for an icon renders
 *  differently on every platform and font, and lands somewhere between "wrong"
 *  and "unreadable box" (reported 2026-08-11: "what's with all these foreign
 *  characters"). Icons are components; labels are words. */
export function catalogUndoLabel(history: CatalogUndoStep[]): string | null {
  const top = history[history.length - 1];
  if (!top) return null;
  if (top.source === "ai") return "AI pick";
  // More than one step back and the top is not the AI's: neither "original"
  // (it isn't) nor "AI pick" (it wasn't).
  return history.length > 1 ? "undo" : "original";
}

/** The hover text, kept beside the label so the two cannot describe different
 *  actions. */
export function catalogUndoTitle(history: CatalogUndoStep[]): string {
  const top = history[history.length - 1];
  if (top?.source === "ai") return "Go back to the photo the AI picked";
  return history.length > 1
    ? "Go back to the previous catalog photo"
    : "Go back to the original catalog photo";
}
