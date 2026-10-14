// A decoded code is asked of the workspace's own records first, on its own,
// never behind the photo upload or the scan request (#6436). The owner's tea,
// already a record, sat on "Looking up…" for the seconds its camera frame took
// to upload: the scan waited for the photo, and the sheet waited for the scan.
// Whatever the rest of the ingest does, a code you have is named the moment
// your own records answer.

export interface KnownAnswer<K> {
  known: K | null;
}

export function ingestBarcode<K, T>(o: {
  code: string;
  /** The workspace's own records only: never an outside lookup. */
  known: (code: string) => Promise<KnownAnswer<K>>;
  onKnown: (known: K) => void;
  /** The rest of the ingest: the photo, the scan request, everything slow. */
  send: () => Promise<T>;
}): Promise<T> {
  void o
    .known(o.code)
    .then((r) => {
      if (r.known) o.onKnown(r.known);
    })
    .catch(() => {});
  return o.send();
}
