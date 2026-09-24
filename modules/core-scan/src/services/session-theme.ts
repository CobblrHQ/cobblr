// "Do these belong together?": the items a session theme is about, and the
// suggestion built from them.
//
// A bulk suggestion's sentence and its action must be built from ONE explicit
// list of item ids per change. The inbox groups rows by session across the
// rows it has loaded, so a session of 36 imported scans can show as a group
// of three; the theme read every pending row of the batch and tagged all of
// them, while the sentence said "these 3" and "10 of them" (#3595). Now the
// group names the ids it shows, the theme is asked about exactly those (in
// that session, still pending), and the answer carries the set it was about:
// every id it proposes to change is in that set, and each change says which.

export interface ThemeItem {
  id: string;
  name: string | null;
  category: string | null;
  is_titled_media: boolean;
}

/** The items a theme may be about: the session's pending rows, narrowed to the
 *  ids the asking surface shows when it names them. An id from another
 *  session, or one already filed, is never in scope, whatever was asked. */
export function themeScope<T extends { id: string }>(sessionPending: readonly T[], askedIds: readonly string[] | null): T[] {
  if (!askedIds) return [...sessionPending];
  const asked = new Set(askedIds);
  return sessionPending.filter((i) => asked.has(i.id));
}

export interface SessionTheme {
  /** The items this answer is about, in order: every id below is one of these. */
  items: Array<{ id: string; name: string | null }>;
  tag: string | null;
  /** The items the tag goes on (all of `items` when there is a tag). */
  tag_item_ids: string[];
  category: { value: string; item_ids: string[] } | null;
}

/** The suggestion from the model's reply, over exactly `items`. A number the
 *  model invents past the list, or repeats, names nothing. */
export function themeFromReply(items: readonly ThemeItem[], parsed: { tag?: unknown; category?: unknown; category_item_numbers?: unknown } | null): SessionTheme {
  const tag = parsed && typeof parsed.tag === "string" && parsed.tag.trim() ? parsed.tag.trim().slice(0, 60) : null;
  const catValue = parsed && typeof parsed.category === "string" && parsed.category.trim() ? parsed.category.trim().slice(0, 80) : null;
  const nums = Array.isArray(parsed?.category_item_numbers) ? (parsed!.category_item_numbers as unknown[]).map((n) => Number(n)) : [];
  const catIds = [...new Set(nums.filter((n) => Number.isInteger(n) && n >= 1 && n <= items.length).map((n) => items[n - 1]!.id))];
  return {
    items: items.map((i) => ({ id: i.id, name: i.name })),
    tag,
    tag_item_ids: tag ? items.map((i) => i.id) : [],
    category: catValue && catIds.length ? { value: catValue, item_ids: catIds } : null,
  };
}
