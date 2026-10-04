// "Recently committed", grouped by session with a split photo as structure.
//
// A split parent made N inbox items and created no entry of its own, so it is
// not an item the session filed (#4579): it is the header the filed pieces sit
// under. Counting it made "2 filed sets" read "3 items", and "send the whole
// session back" tried to send the parent back, which the api refuses, and
// reported an unnamed failure.
import type { ScanInboxItem } from "./api";

export const splitIdsOf = (it: ScanInboxItem): string[] => {
  const v = (it.suggested_metadata as { split_into?: unknown } | null)?.split_into;
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
};
export const isSplitParent = (it: ScanInboxItem): boolean =>
  Array.isArray((it.suggested_metadata as { split_into?: unknown } | null)?.split_into);
/** The ids "send the whole session back" covers: what was filed. A split
 *  parent is structure and never goes back (the api refuses it). */
export const sendBackIdsOf = (items: readonly ScanInboxItem[]): string[] => items.filter((i) => !isSplitParent(i)).map((i) => i.id);
const splitFromOf = (it: ScanInboxItem): string | null => {
  const v = (it.suggested_metadata as { split_from?: unknown } | null)?.split_from;
  return typeof v === "string" && v ? v : null;
};

export interface CommittedGroup {
  key: string;
  batchId: string | null;
  /** Every row in the group, parents included. */
  items: ScanInboxItem[];
  /** Split parents, each with the filed pieces that came from it. */
  splits: Array<{ parent: ScanInboxItem; children: ScanInboxItem[] }>;
  /** What the session filed: every row that is not a split parent. */
  filed: ScanInboxItem[];
  /** Filed rows that belong to no split parent shown here. */
  loose: ScanInboxItem[];
}

export function committedGroupsOf(recent: readonly ScanInboxItem[]): CommittedGroup[] {
  const byKey = new Map<string, CommittedGroup>();
  const groups: CommittedGroup[] = [];
  for (const it of recent) {
    const key = it.scan_batch_id ?? it.id;
    let g = byKey.get(key);
    if (!g) {
      g = { key, batchId: it.scan_batch_id ?? null, items: [], splits: [], filed: [], loose: [] };
      byKey.set(key, g);
      groups.push(g);
    }
    g.items.push(it);
  }
  for (const g of groups) {
    const parents = g.items.filter(isSplitParent);
    for (const p of parents) g.splits.push({ parent: p, children: g.items.filter((c) => splitFromOf(c) === p.id) });
    const nested = new Set(g.splits.flatMap((s) => s.children.map((c) => c.id)));
    g.filed = g.items.filter((it) => !isSplitParent(it));
    g.loose = g.filed.filter((it) => !nested.has(it.id));
  }
  return groups;
}
