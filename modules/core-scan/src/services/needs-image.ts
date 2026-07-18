// Which records in a collection still need a picture?
//
// Pure + tiny on purpose: the bulk "fetch missing covers" sweep is a
// destructive-ish batch (it spends web searches and writes image_path on N
// records), so the rule for WHICH records it touches is worth pinning in a
// test rather than burying in a route handler.
//
// The rule: a record needs an image when it has no usable image_path. It is NOT
// skipped for having a colour swatch or a thumbnail-ish field — those are
// presentation fallbacks, not a stored image — and it IS skipped when it
// already has one, so re-running the sweep never overwrites a picture the user
// chose (idempotent by design; the sweep is safe to press twice).

export interface ImageCandidate {
  id: string;
  title?: string | null;
  image_path?: string | null;
}

/** The subset of `items` that has no stored image, capped at `limit`.
 *  Order is preserved so a capped run works through the list predictably
 *  (press it again for the next batch). */
export function needsImage<T extends ImageCandidate>(items: readonly T[], limit: number): T[] {
  const out: T[] = [];
  for (const it of items) {
    if (out.length >= limit) break;
    const has = typeof it.image_path === "string" && it.image_path.trim().length > 0;
    if (!has) out.push(it);
  }
  return out;
}
