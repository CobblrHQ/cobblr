// Which view a collection opens on, and remembering the one you picked.
//
// A first-time reviewer followed Groceries in the navigation and got the
// dense table with ids and minimums; the approachable views the site shows
// ("What's on hand", the cover wall) were a tab away, and reaching one and
// coming back through the nav dropped them to the table again (2026-09-12).
// Nothing declared a first view and nothing remembered a pick.
//
// The rule, in order: the URL's own `?view=` (a link means exactly that, and
// `?view=table` means the table, this once, without remembering); the view
// this device last picked for this collection (Table counts as a pick); the
// view the bundle marked `is_default`; else the table.
const KEY = (slug: string, instance: string) => `cobblr.instanceView.${slug}.${instance}`;

/** The `?view=` value that names the table: a link to "everything" from a
 *  filtered view's empty state, honoured once and never remembered. */
export const TABLE = "table";

/** Read the view this device last opened for a collection: a view id, ""
 *  for the table, or null when nothing was ever picked here. */
export function rememberedView(slug: string, instance: string): string | null {
  try {
    return window.localStorage.getItem(KEY(slug, instance));
  } catch {
    return null;
  }
}

/** Remember a pick; null means the table. Best-effort, a private window or a
 *  blocked store just means the collection opens on its default next time. */
export function rememberView(slug: string, instance: string, viewId: string | null): void {
  try {
    window.localStorage.setItem(KEY(slug, instance), viewId ?? "");
  } catch {
    /* nothing to do */
  }
}

/** The view to open. Pure, so the order of precedence is pinned by a test
 *  rather than by reading the page. `""` from the remembered slot is the
 *  table, deliberately, so a person who chose the table is not bounced to the
 *  bundle's default each visit. A remembered id that no longer exists (the
 *  view was deleted) falls through to the default. */
export function initialViewId(args: {
  urlView: string | null;
  remembered: string | null;
  views: ReadonlyArray<{ id: string; is_default?: boolean; pinned?: boolean }>;
}): string | null {
  if (args.urlView === TABLE) return null;
  if (args.urlView) return args.urlView;
  if (args.remembered === "") return null;
  if (args.remembered && args.views.some((v) => v.id === args.remembered)) return args.remembered;
  return args.views.find((v) => v.is_default && v.pinned)?.id ?? null;
}
