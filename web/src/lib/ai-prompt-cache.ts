// How much of a call's prompt came from the provider's prompt cache (#5319),
// in words for the AI page. A read costs a tenth of the input price, so this
// is where a cached chat turn's saving shows.

const n = (v: number | string | null | undefined): number => (v == null ? 0 : Number(v) || 0);

/** The share of the prompt read from the cache, 0 to 1, or null when the
 *  provider reported no cache at all. */
export function promptCacheShare(input: number | string | null | undefined, read: number | string | null | undefined, write: number | string | null | undefined): number | null {
  const r = n(read);
  const w = n(write);
  if (!r && !w) return null;
  const total = n(input) + r + w;
  return total > 0 ? r / total : null;
}

/** "38.3k tokens from the cache (97%)", or null with nothing read from it. */
export function promptCacheWords(input: number | string | null | undefined, read: number | string | null | undefined, write: number | string | null | undefined): string | null {
  const share = promptCacheShare(input, read, write);
  if (share === null || !n(read)) return null;
  const r = n(read);
  const tokens = r >= 1000 ? `${(r / 1000).toFixed(1)}k` : String(r);
  return `${tokens} tokens from the cache (${Math.round(share * 100)}%)`;
}
