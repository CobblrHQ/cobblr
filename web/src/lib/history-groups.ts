// A record's history, grouped the way a person reads it (#4517).
//
// Ten field edits used to be ten "updated" lines, and the empty ones said
// nothing. Consecutive edits by one person within half an hour, with nobody
// else's change in between, are one group: a header line, then one line per
// field, each with its own time. A field changed twice in the group shows once,
// from what it first was to what it last became. Anything that is not an edit
// (created, moved, a part installed) stays a line of its own.
import type { ActivityEntry, SaidChange } from "./api";

export const GROUP_WINDOW_MS = 30 * 60 * 1000;
/** Lines a group shows before "+N more". */
export const GROUP_SHOWN = 5;

export interface HistoryLine extends SaidChange {
  /** When this field last changed in the group. */
  at: string;
}

export type HistoryItem =
  | { kind: "changes"; key: string; head: ActivityEntry; entries: ActivityEntry[]; lines: HistoryLine[]; startedAt: string }
  | { kind: "event"; key: string; entry: ActivityEntry };

const isEdit = (e: ActivityEntry) => (e.action.endsWith("_updated") || e.action === "updated") && (e.said?.length ?? 0) > 0;
const who = (e: ActivityEntry) => `${e.user_id ?? "system"}|${e.api_token_id ?? ""}|${e.via_kind ?? ""}`;

/** `entries` newest first, as the log returns them. Groups come out newest
 *  first; the lines inside a group read in the order they happened. */
export function groupHistory(entries: ActivityEntry[], windowMs = GROUP_WINDOW_MS): HistoryItem[] {
  const out: HistoryItem[] = [];
  let open: Extract<HistoryItem, { kind: "changes" }> | null = null;
  let openNewest = 0;
  for (const e of entries) {
    if (!isEdit(e)) {
      open = null;
      out.push({ kind: "event", key: `e${e.id}`, entry: e });
      continue;
    }
    const t = new Date(e.occurred_at).getTime();
    if (!open || who(open.head) !== who(e) || openNewest - t > windowMs) {
      open = { kind: "changes", key: `g${e.id}`, head: e, entries: [], lines: [], startedAt: e.occurred_at };
      openNewest = t;
      out.push(open);
    }
    open.entries.push(e);
    open.startedAt = e.occurred_at;
    // Newest first in, so an earlier change of a field already listed only
    // moves its "from" back to what the field was before this one.
    for (const c of [...(e.said ?? [])].reverse()) {
      const seen = open.lines.find((l) => l.field === c.field);
      if (seen) {
        if (c.from !== undefined) seen.from = c.from;
        else delete seen.from;
      } else open.lines.unshift({ ...c, at: e.occurred_at });
    }
  }
  // A field that ends where it started changed nothing a person can see.
  for (const item of out) {
    if (item.kind !== "changes") continue;
    item.lines = item.lines.filter((l) => !l.from || l.from.text !== l.to.text || l.from.photo?.file_id !== l.to.photo?.file_id);
    item.lines.sort((a, b) => new Date(a.at).getTime() - new Date(b.at).getTime());
  }
  return out.filter((i) => i.kind === "event" || i.lines.length > 0 || i.entries.some((e) => e.restorable));
}
