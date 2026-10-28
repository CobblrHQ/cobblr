// The house rules a new member reads first (#8662): a pinned Knowledge entry
// shows on a plain member's Home until they have opened it or put it away.
//
// "Pinned" meant a place at the top of the Knowledge list and nothing else, so
// the rules an owner wrote for a makerspace reached a new member only if they
// went looking. The put-away is the account's own tip state (`users.tips`,
// key `read-first:<entry id>`), so it holds on every device and in every
// workspace the entry is not in.

export interface PinnedEntry {
  id: string;
  title: string;
  body: string | null;
}

export interface ReadFirstCard {
  kind: "read_first";
  label: string;
  count: number;
  sample: string[];
  route: string;
  entries: Array<{ id: string; title: string; body: string; tip: string }>;
}

/** The tip id an entry is put away under. */
export const readFirstTip = (entryId: string): string => `read-first:${entryId}`;

/** The card, or null: it is for a plain member (the owner wrote the rules), only the entries they have not opened. */
export function readFirstCard(o: { role: string | undefined; pinned: readonly PinnedEntry[]; dismissed: Record<string, unknown> | undefined }): ReadFirstCard | null {
  if (o.role !== "member" && o.role !== "operator") return null;
  const unread = o.pinned.filter((e) => !o.dismissed?.[readFirstTip(e.id)]);
  if (!unread.length) return null;
  return {
    kind: "read_first",
    label: unread.length === 1 ? "to read first" : "things to read first",
    count: unread.length,
    sample: unread.slice(0, 3).map((e) => e.title),
    route: "/knowledge",
    entries: unread.slice(0, 5).map((e) => ({ id: e.id, title: e.title, body: (e.body ?? "").slice(0, 4000), tip: readFirstTip(e.id) })),
  };
}
