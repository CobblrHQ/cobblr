// Resolving a bundle app's saved-view REFERENCES into real view ids.
//
// The App Player's `view` and `stat` blocks bind to a saved view by its
// database id. A bundle author has no such id: the views the bundle provides
// don't exist until the moment it is installed into a workspace, and they get a
// different id in every workspace. So a bundle app could not use either block
// at all, and the two that shipped (Outfit Planner, Cataloging Bench) each fell
// back to one big Tier-B `custom` HTML blob for what should have been a table.
//
// The fix is a reference the author CAN write - the view's name - resolved to
// the concrete id at install time, right after that bundle's saved views are
// seeded. The stored definition is always concrete, so the Player and its
// schema are untouched and never have to understand a placeholder.

/** A saved view this install just wrote, as returned by the insert. */
export interface SeededView {
  id: string;
  name: string;
  entity_kind: string;
}

interface ViewRefBlock {
  type?: unknown;
  view_id?: unknown;
  view_name?: unknown;
  view_kind?: unknown;
}

export interface ResolveResult {
  pages: unknown[];
  /** Names no seeded view matched, in encounter order. The caller decides how
   *  loud to be; `lint:bundle-app-view-refs` makes this unreachable for
   *  first-party bundles by checking the same rule at authoring time. */
  unresolved: string[];
}

/** Blocks that bind to a saved view. Kept in sync with core-apps' Block union. */
const VIEW_BLOCK_TYPES = new Set(["view", "stat"]);

/**
 * Rewrite every `view_name` reference in a bundle app's pages into the
 * `view_id` of the matching seeded view.
 *
 * `view_kind` disambiguates when one bundle seeds two views with the same name
 * on different entity kinds ("All" on both a Spools and a Filament instance).
 * Without it an ambiguous name is left UNRESOLVED rather than silently bound to
 * whichever row was inserted first - a wrong table is worse than a missing one,
 * because it looks like it works.
 */
export function resolveAppViewRefs(pages: unknown[], views: SeededView[]): ResolveResult {
  const unresolved: string[] = [];

  const resolved = pages.map((page) => {
    if (!page || typeof page !== "object") return page;
    const p = page as { blocks?: unknown };
    if (!Array.isArray(p.blocks)) return page;

    const blocks = p.blocks.map((block) => {
      if (!block || typeof block !== "object") return block;
      const b = block as ViewRefBlock;
      if (typeof b.type !== "string" || !VIEW_BLOCK_TYPES.has(b.type)) return block;
      if (typeof b.view_name !== "string") return block;

      const wantKind = typeof b.view_kind === "string" ? b.view_kind : null;
      const matches = views.filter(
        (v) => v.name === b.view_name && (wantKind === null || v.entity_kind === wantKind),
      );

      const { view_name, view_kind, ...rest } = b as Record<string, unknown>;
      void view_name;
      void view_kind;

      if (matches.length !== 1) {
        unresolved.push(b.view_name);
        return block;
      }
      return { ...rest, view_id: matches[0]!.id };
    });

    return { ...p, blocks };
  });

  return { pages: resolved, unresolved };
}
