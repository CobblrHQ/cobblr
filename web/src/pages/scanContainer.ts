// The "this scan IS a container" one-shot: an inbox item (a scanned storage
// tote) becomes a core-locations bin in one action — location created, the
// product identity written onto it (confirm-into-location), and optionally
// armed as the standing file-bin so the very next scans land inside it.
// These two helpers are the pure logic behind that sheet; unit-tested.

/** Does this scan look like a storage container — the kind of product a user
 *  would convert into a bin? Conservative, name/category vocabulary only: a
 *  false negative costs one trip to the More menu, a false positive puts a
 *  "turn into a bin" offer on a book. */
export function looksLikeContainer(
  name: string | null | undefined,
  category: string | null | undefined,
): boolean {
  const hay = `${name ?? ""} ${category ?? ""}`.toLowerCase();
  if (!hay.trim()) return false;
  return /\b(storage (box|bin|tote|container|drawer|cube|basket)|organizer|organiser|tote|crate|bin|baskets?|storage & organization)\b/.test(
    hay,
  );
}

/** The next free "Bin N" name given the workspace's existing location names —
 *  "Bin 18" when Bin 17 is the highest, "Bin 1" when none exist yet. Matching
 *  is case-insensitive but the offered name uses the canonical spelling. */
export function nextBinName(existingNames: readonly string[]): string {
  let max = 0;
  for (const n of existingNames) {
    const m = /^\s*bin\s+(\d{1,5})\s*$/i.exec(n);
    if (m) max = Math.max(max, Number(m[1]));
  }
  return `Bin ${max + 1}`;
}
