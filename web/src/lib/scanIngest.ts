// A decoded code is asked of the workspace's own records first, on its own,
// never behind the photo upload or the scan request (#6436). The owner's tea,
// already a record, sat on "Looking up…" for the seconds its camera frame took
// to upload: the scan waited for the photo, and the sheet waited for the scan.
// Whatever the rest of the ingest does, a code you have is named the moment
// your own records answer. A code still in the scan inbox answers with that
// row (#6554): the scan that follows lands on it, and it wins over a record.

/** What a scan that landed on a row already in the inbox says, from the scan's
 *  own answer: its new count and the count Undo goes back to. Null for a scan
 *  that made a new row, or that does not count (#6554). It was decided from
 *  the inbox lookup that runs beside the scan, and when the scan answered
 *  first the person was told nothing (#6881). */
export function scannedAgain(
  answer: { scanned_again?: boolean; quantity?: number | string | null },
  purpose: string,
): { now: number; back: number } | null {
  if (!answer.scanned_again || purpose !== "arrival") return null;
  const now = Math.max(1, Math.round(Number(answer.quantity ?? 1)) || 1);
  return { now, back: Math.max(1, now - 1) };
}

export interface KnownAnswer<K, R = unknown> {
  known: K | null;
  /** The unfiled inbox row for this code, when there is one. */
  inbox_row?: R | null;
}

export function ingestBarcode<K, T, R = unknown>(o: {
  code: string;
  /** The workspace's own records and inbox only: never an outside lookup. */
  known: (code: string) => Promise<KnownAnswer<K, R>>;
  onKnown: (known: K) => void;
  /** The inbox row this code already is, shown before the scan lands. */
  onInboxRow?: (row: R) => void;
  /** The rest of the ingest: the photo, the scan request, everything slow. */
  send: () => Promise<T>;
}): Promise<T> {
  void o
    .known(o.code)
    .then((r) => {
      if (r.inbox_row) o.onInboxRow?.(r.inbox_row);
      if (r.known) o.onKnown(r.known);
    })
    .catch(() => {});
  return o.send();
}
