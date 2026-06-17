// Find-or-create matching for the scan "Type card": given a child item's
// in-progress field values (a spool's material/colour/diameter) and the parent
// "type" instance's existing rows, decide whether the type already exists.
// Mirrors what `inventory:lift-to-type` does on commit, so the card's preview
// agrees with what actually happens. Pure + generic — the key fields all come
// from the bundle's `parent` config; nothing here knows "filament".

export const normVal = (v: unknown): string => String(v ?? "").trim().toLowerCase();

/** Read a key field off a row, preferring a native top-level column
 *  (manufacturer) and falling back to custom `metadata` (material, colour…). */
export function readField(row: Record<string, unknown>, key: string): unknown {
  const top = row[key];
  if (top !== undefined && top !== null && top !== "") return top;
  const md = row.metadata as Record<string, unknown> | undefined;
  return md?.[key];
}

export interface ParentMatch<T> {
  /** The key fields the child item has actually filled (we only match on these,
   *  and only claim "existing"/"new" once at least one is present). */
  present: string[];
  /** The existing parent row all present key fields equal, if any. */
  match: T | undefined;
}

/** Match a child item's values against the parent instance's rows by the
 *  config's `key_fields`: an EXISTING type is one where every *present* key
 *  field matches (case-insensitive, trimmed). No present keys → no claim. */
export function matchParentType<T extends Record<string, unknown>>(
  rows: T[],
  keyFields: string[],
  values: Record<string, unknown>,
): ParentMatch<T> {
  const present = keyFields.filter((k) => normVal(values[k]) !== "");
  if (present.length === 0) return { present, match: undefined };
  const match = rows.find((row) =>
    present.every((k) => normVal(readField(row, k)) === normVal(values[k])),
  );
  return { present, match };
}
