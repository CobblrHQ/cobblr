// What the inbox shows for a search: the waiting rows it finds AND the
// sessions with no rows of their own (a document whose read failed, or is
// under way) it finds. Every view of the inbox (the list, the gallery, the
// caption, "nothing matches") reads this one answer, so no view can narrow
// the rows and leave an unrelated failed receipt standing (#6033), or draw
// the rows and drop the receipts (#6034).
import { inboxRowSaid, inboxSearchFinds, inboxSessionSaid } from "@cobblr/platform-contract/scan-search";
import type { ScanBatchMeta, ScanInboxItem } from "./api";

export interface InboxShown {
  items: ScanInboxItem[];
  sessions: Record<string, ScanBatchMeta>;
}

export function inboxShown(
  items: ScanInboxItem[],
  rowless: Record<string, ScanBatchMeta>,
  words: readonly string[],
  fileNames: ReadonlyMap<string, string>,
): InboxShown {
  if (!words.length) return { items, sessions: rowless };
  const sessions: Record<string, ScanBatchMeta> = {};
  for (const [id, meta] of Object.entries(rowless)) {
    const filename = meta.source_file_id ? fileNames.get(meta.source_file_id) : null;
    if (inboxSearchFinds(words, inboxSessionSaid(meta, filename))) sessions[id] = meta;
  }
  return { items: items.filter((it) => inboxSearchFinds(words, inboxRowSaid(it))), sessions };
}
