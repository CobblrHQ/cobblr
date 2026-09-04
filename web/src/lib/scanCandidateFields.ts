// A match is a SNAPSHOT. The table can change under it.
//
// The matchmaker keeps only the fields the destination declared at the moment
// it ran ("keep only fields that exist on the table"). Nothing re-checks that
// afterwards, and a scan can sit in the inbox for weeks - across a bundle
// upgrade that retires a field, or a person deleting one.
//
// That is not hypothetical. A humidifier scanned on 2026-07-14 carried
// `room: "Living room"`; on 2026-07-15 the Home Inventory bundle retired its
// Room field into the platform's real Locations (#1090). Eleven days later the
// card still showed a `room` chip saying "Living room" beside the item's actual
// location, "Den" - two answers to "where is this thing", one of them from a
// table shape that no longer exists, and neither the label nor the value could
// be saved anywhere.
//
// So the destination's CURRENT fields decide what a card shows and what a
// confirm writes. Read time, not just write time.

/** The shape both callers share: a destination's declared fields. */
export interface DestinationFields {
  fields: Array<{ name: string }>;
}

/**
 * The candidate's fields, minus anything the destination no longer declares.
 *
 * `entry` null or undefined (the menu has not loaded, or the destination is not
 * in it) means WE CANNOT TELL - and hiding a real field is worse than briefly
 * showing a stale one, so the fields pass through untouched.
 */
export function fieldsStillOnTable<T>(
  entry: DestinationFields | null | undefined,
  fields: Record<string, T> | null | undefined,
): Record<string, T> {
  const src = fields ?? {};
  if (!entry) return { ...src };
  const declared = new Set(entry.fields.map((f) => f.name));
  const out: Record<string, T> = {};
  for (const [k, v] of Object.entries(src)) if (declared.has(k)) out[k] = v;
  return out;
}

/** The keys that were dropped - what the scan read and the table can no longer
 *  hold. Kept separate so a caller can say so rather than vanish them. */
export function fieldsNoLongerOnTable(
  entry: DestinationFields | null | undefined,
  fields: Record<string, unknown> | null | undefined,
): string[] {
  if (!entry || !fields) return [];
  const declared = new Set(entry.fields.map((f) => f.name));
  return Object.keys(fields).filter((k) => !declared.has(k));
}
