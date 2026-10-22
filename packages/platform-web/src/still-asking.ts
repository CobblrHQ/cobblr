import { useRef } from "react";

// Whether a page should still hold back for a read: until it first answers
// or first fails, never through its retries. A page that draws whole once
// its reads answer (#7781) would otherwise sit blank for the seconds a
// failing read spends retrying, for a part that may not even show.
export function stillAsking(q: { isLoading: boolean; failureCount: number }): boolean {
  return q.isLoading && q.failureCount === 0;
}

/** Whether a page should still hold back for these reads. Once it has drawn
 *  it never goes back to waiting: a part it draws can ask the same read
 *  again (a read that failed is asked again by each new reader), and the
 *  page turned back to "loading…", unmounted that part and drew it again,
 *  round and round. */
export function useStillAsking(...reads: Array<{ isLoading: boolean; failureCount: number }>): boolean {
  const drawn = useRef(false);
  if (drawn.current) return false;
  const asking = reads.some(stillAsking);
  if (!asking) drawn.current = true;
  return asking;
}
