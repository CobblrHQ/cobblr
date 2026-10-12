// What a typed search finds on the scan inbox page: a waiting row by what its
// card says, and a session with no rows of its own (a document whose read
// failed, or is under way) by what its row says, its file's name first.
//
// The page once narrowed only rows, so a failed receipt stayed on screen
// under "nothing matches" (#6033). Every word must appear somewhere, in any
// case.

export function inboxSearchWords(q: string): string[] {
  return q.toLowerCase().split(/\s+/).filter(Boolean);
}

export function inboxSearchFinds(words: readonly string[], said: ReadonlyArray<string | null | undefined>): boolean {
  if (!words.length) return true;
  const hay = said
    .filter((s): s is string => typeof s === "string" && s.length > 0)
    .join(" ")
    .toLowerCase();
  return words.every((w) => hay.includes(w));
}

export interface SearchableInboxRow {
  suggested_name: string | null;
  barcode_text?: string | null;
  ai_notes?: string | null;
  suggested_manufacturer?: string | null;
  scan_area?: string | null;
  suggested_sku?: string | null;
}

/** What a waiting row's card says about it. */
export function inboxRowSaid(row: SearchableInboxRow): Array<string | null | undefined> {
  return [row.suggested_name, row.barcode_text, row.ai_notes, row.suggested_manufacturer, row.scan_area, row.suggested_sku];
}

export interface SearchableInboxSession {
  label?: string | null;
  vendor?: string | null;
  origin_from?: string | null;
  order_ref?: string | null;
  tracking_number?: string | null;
}

/** What a session with no rows says about itself: the file it came from and
 *  the names its row shows. */
export function inboxSessionSaid(session: SearchableInboxSession, filename: string | null | undefined): Array<string | null | undefined> {
  return [filename, session.label, session.vendor, session.origin_from, session.order_ref, session.tracking_number];
}
