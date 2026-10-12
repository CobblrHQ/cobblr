// A session's rows with each split line's parts under it (#6067). The page
// drew a pack's ten spools as ten loose rows, with nothing to say they were
// one purchased pack. A part answers to its parent (split_from, or
// split_off_from for what was split off a line still open); the parts of one
// parent sit together under it, at the first part's place in the session.
import { splitParentIdOf, type SplitParentSummary } from "@cobblr/platform-contract/split-line";
import type { ScanInboxItem } from "./api";

export type SplitParent = SplitParentSummary & { row: ScanInboxItem | null };

export type SplitEntry =
  | { kind: "item"; item: ScanInboxItem }
  | {
      kind: "split";
      parentId: string;
      summary: SplitParent | null;
      /** The parent itself when it is still open on this page (Split off). */
      parentItem: ScanInboxItem | null;
      parts: ScanInboxItem[];
    };

export function splitLayoutOf(items: readonly ScanInboxItem[], parents: Readonly<Record<string, SplitParent>>): SplitEntry[] {
  const onPage = new Map(items.map((i) => [i.id, i]));
  const out: SplitEntry[] = [];
  const groups = new Map<string, Extract<SplitEntry, { kind: "split" }>>();
  const groupFor = (parentId: string): Extract<SplitEntry, { kind: "split" }> | null => {
    const known = groups.get(parentId);
    if (known) return known;
    const summary = parents[parentId] ?? null;
    const parentItem = onPage.get(parentId) ?? null;
    // A part whose line nothing here can show stays a row of its own.
    if (!summary && !parentItem) return null;
    const g = { kind: "split" as const, parentId, summary, parentItem, parts: [] as ScanInboxItem[] };
    groups.set(parentId, g);
    out.push(g);
    return g;
  };
  for (const item of items) {
    const parentId = splitParentIdOf(item.suggested_metadata);
    if (parentId) {
      const g = groupFor(parentId);
      if (g) {
        g.parts.push(item);
        continue;
      }
    }
    // A line still open whose parts were split off it heads their group.
    const off = (item.suggested_metadata as { split_off_into?: unknown } | null)?.split_off_into;
    if (Array.isArray(off) && off.some((id) => typeof id === "string" && onPage.has(id))) {
      groupFor(item.id);
      continue;
    }
    out.push({ kind: "item", item });
  }
  return out;
}
