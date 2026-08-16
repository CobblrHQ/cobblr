// Which item is the scanner about to be pointed at, and what does its prompt say?
//
// The point of the queue is that you never hunt: you open the scanner and it
// already knows what you came to photograph. That only holds if the ORDER is
// predictable and a dismissal is remembered, so this is a pure rule rather than
// something the component works out inline.

import type { ScanInboxItem } from "./api";

/** How the scanner arms for an item off this queue.
 *
 *  `"catalog"`, emphatically NOT `"retake"`. The two read alike and do opposite
 *  things: retake calls rerun-AI with `wrong: true`, which re-identifies the
 *  item from the new frame, treats the result as authoritative AND writes a
 *  correction back to the shared barcode database. Catalog makes the shot the
 *  display photo and leaves the identification alone.
 *
 *  This queue is fed by someone saying "the PICTURE is bad", which says nothing
 *  about the NAME. Arming with retake would take a correctly identified item,
 *  re-identify it because a better photo arrived, and vote that re-reading out
 *  to every other workspace — the exact overreach the evidence model exists to
 *  prevent (a photo may not overrule a barcode by itself; see
 *  docs/design-decisions/scan-evidence-model.md).
 *
 *  It shipped as `"retake"` and was caught on review the same day. A constant
 *  here rather than a string at the call sites, because the mistake is that the
 *  two names sound like synonyms, and a literal in JSX carries none of the
 *  above. */
export const PHOTO_WANTED_ARM_MODE = "catalog";

/** Items a person marked "I'll photograph this", oldest intent first.
 *
 *  Oldest first, deliberately: you mark things as you find them at a desk, and
 *  when you get up you work the pile in the order you built it. Newest-first
 *  would hand back the one still freshest in mind and bury the one most likely
 *  forgotten. */
export function photoQueue(items: ScanInboxItem[]): ScanInboxItem[] {
  return items
    .filter((i) => (i.suggested_metadata as { photo_wanted?: boolean } | null)?.photo_wanted === true)
    .sort((a, b) => Date.parse(a.updated_at) - Date.parse(b.updated_at));
}

/**
 * The item the prompt should offer, given what has been waved off this session.
 *
 * `dismissed` is session-scoped on purpose. "Not now" means not now, not never:
 * clearing the mark is what "never" means, and it has its own button on the
 * card. So a wave-off survives until the scanner is closed and no longer.
 */
export function nextWanted(
  queue: ScanInboxItem[],
  dismissed: ReadonlySet<string>,
): ScanInboxItem | null {
  return queue.find((i) => !dismissed.has(i.id)) ?? null;
}

/** What the one-line pill reads.
 *
 *  ONE line, always — it lives over a viewfinder, where every pixel it takes is
 *  a pixel of the thing you are trying to photograph. The count only appears
 *  when there IS a count, so the common case (one item) spends no width saying
 *  "1 of 1". */
export function promptLabel(item: ScanInboxItem, remaining: number): string {
  const name = item.suggested_name?.trim() || "this item";
  return remaining > 1 ? `${name} · +${remaining - 1}` : name;
}
