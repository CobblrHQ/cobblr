// How long a server asked us to wait, and the words for it. Imports nothing,
// so api.ts (which builds every error) and request-failure.ts (which reads
// them) can both use it without importing each other.

/** Retry-After as seconds: either delta-seconds or an HTTP date. Null when
 *  absent or unreadable, never a guess. */
export function parseRetryAfter(header: string | null, now = Date.now()): number | null {
  if (!header) return null;
  const s = header.trim();
  if (/^\d+$/.test(s)) return Number(s);
  const at = Date.parse(s);
  if (Number.isNaN(at)) return null;
  return Math.max(0, Math.ceil((at - now) / 1000));
}

/** "about 5 minutes", "about a minute", "30 seconds". */
export function waitWords(sec: number): string {
  if (sec < 60) return `${Math.max(1, Math.round(sec))} seconds`;
  const min = Math.ceil(sec / 60);
  return min === 1 ? "about a minute" : `about ${min} minutes`;
}

/** The sentence a 429 carries everywhere: the network is making too many
 *  requests, never the person's connection. */
export function busySentence(retryAfterSec: number | null): string {
  return retryAfterSec
    ? `Too many attempts from this network. Try again in ${waitWords(retryAfterSec)}.`
    : "Too many attempts from this network. Wait a little, then try again.";
}
