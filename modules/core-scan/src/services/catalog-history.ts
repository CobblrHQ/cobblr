// The catalog image's UNDO STACK, as a pure rule.
//
// A real item walks: the blind first web result -> maybe "✨ Pick best (AI)" ->
// maybe one you picked yourself -> maybe your own photo. Revert has to be undo
// over that walk, one press per step (reported 2026-08-11: "it should act like
// undo and go back to the prior pick, so I should be able to click it multiple
// times").
//
// It used to keep a single `orig_catalog`, captured once on the FIRST override.
// Because the AI ranker applies through the same endpoint as a hand-pick, the
// AI's own apply was usually that first override — so it stamped the stash with
// the raw first web result, and one press of Revert jumped all the way past the
// AI's judgement to the worst image in the sequence.
//
// Lives here, separate from the route, so the sequence can be tested without a
// database or an Express request (the pool-release-rule precedent).

/** Where a catalog image came from. Labels a step so the UI can say what
 *  pressing undo lands on — "↺ AI pick" reads very differently from
 *  "↺ original". */
export type CatalogSource = "web" | "ai" | "yours" | "upload" | "pick" | "crop";

export interface CatalogStep {
  url: string | null;
  file_id: string | null;
  source?: CatalogSource;
}

/** Metadata is read on every render of every card, and nobody undoes through
 *  more than a handful of picks. Oldest steps fall off the bottom, so the first
 *  web result is what a deep history forgets last. */
export const MAX_CATALOG_HISTORY = 10;

/** Seed a stack for an item that predates it: the old single stash becomes the
 *  one step there is, so its Revert keeps working and behaves like undo from
 *  here on. */
export function seedHistory(
  history: unknown,
  origCatalog: { url: string | null; file_id: string | null } | undefined,
): CatalogStep[] {
  if (Array.isArray(history)) return history as CatalogStep[];
  if (origCatalog) return [{ ...origCatalog, source: "web" }];
  return [];
}

/** Applying a new image pushes the one it REPLACES. */
export function pushStep(
  history: CatalogStep[],
  current: { url: string | null; file_id: string | null },
  currentSource: CatalogSource | undefined,
): CatalogStep[] {
  return [...history, { ...current, source: currentSource ?? "web" }].slice(-MAX_CATALOG_HISTORY);
}

export interface PopResult {
  /** The image to restore, or null when there is nothing to undo. */
  restore: CatalogStep | null;
  /** What remains on the stack after this pop. */
  rest: CatalogStep[];
  /** True when the pop lands back on the auto image, which relinquishes the
   *  user's pick — the caller drops the user-set lock and the stack. */
  atBottom: boolean;
}

export function popStep(history: CatalogStep[]): PopResult {
  const restore = history[history.length - 1] ?? null;
  const rest = restore ? history.slice(0, -1) : history;
  return { restore, rest, atBottom: !!restore && rest.length === 0 };
}

// The undo control's LABEL is deliberately not here. It is only ever rendered
// client-side, and web must not import from a module, so a copy here would be
// dead code that silently drifts from the live one. It lives (unit-tested) in
// web/src/pages/scanCatalogUndo.ts instead.
