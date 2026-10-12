// What an edit changed, old → new, worked out once at the activity log.
//
// A record's History said "<name> updated" with nothing after it for every custom
// field edit (Year, License plate, Color), and "purchase price cents →
// 430000" for the rest: the log kept only the new values of a PATCH, so it
// could not say what a field had been, and nothing said which fields a
// custom-field edit touched (#4517). A writer now hands the log the row as it
// was (`before`) with the patch; the log stores the fields that really
// changed, custom ones included, each with what it was and what it is.

export interface ActivityChange {
  /** The column or custom field's name. */
  field: string;
  /** A custom field (a key of the record's metadata bag). */
  custom?: true;
  secret?: true;
  from: unknown;
  to: unknown;
}

/** The one rule for what is not a person's field (#5863): bookkeeping, and
 *  columns the database or a heal pass works out from the fields a person did
 *  change (a search text, a hash of the text, the readings taken from it).
 *  None is a change anyone made, so a record's History, the activity feed's
 *  sentences and Cobb's read of the log never name one. DERIVED_FIELDS are
 *  the worked-out half; a column Postgres generates is held to it by
 *  lint:history-hides-derived-columns. */
export const DERIVED_FIELDS: ReadonlySet<string> = new Set(["search_vector", "search_blob", "measures", "measures_key", "measures_for", "stock_revision"]);
export const INTERNAL_FIELDS: ReadonlySet<string> = new Set([
  "updated_at", "created_at", "id", "org_id", "instance", "metadata", "fields",
  ...DERIVED_FIELDS,
]);

/** True for a field no person sees or edits as such (INTERNAL_FIELDS). */
export const isInternalField = (field: string): boolean => INTERNAL_FIELDS.has(field);

const bagOf = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});

const same = (a: unknown, b: unknown): boolean => {
  if (a === b) return true;
  if ((a === null || a === undefined || a === "") && (b === null || b === undefined || b === "")) return true;
  if (a instanceof Date || b instanceof Date) return new Date(a as string).getTime() === new Date(b as string).getTime();
  if (typeof a === "number" || typeof b === "number") return a !== null && b !== null && a !== "" && b !== "" && Number(a) === Number(b);
  if (typeof a === "object" || typeof b === "object") return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
  return false;
};

const plain = (v: unknown): unknown => (v instanceof Date ? v.toISOString() : v === undefined ? null : v);

/** The fields a patch really changed on a row, native and custom, in the
 *  patch's order. A key the patch sends with the value it already had is not a
 *  change; a custom field is read from the patch's `metadata` (or `fields`)
 *  bag against the row's. */
export function changesOf(before: unknown, patch: unknown): ActivityChange[] {
  const was = bagOf(before);
  const now = bagOf(patch);
  const out: ActivityChange[] = [];
  for (const [field, to] of Object.entries(now)) {
    if (to === undefined || isInternalField(field)) continue;
    if (!same(was[field], to)) out.push({ field, from: plain(was[field]), to: plain(to) });
  }
  const wasBag = bagOf(was.metadata);
  for (const key of ["metadata", "fields"]) {
    for (const [field, to] of Object.entries(bagOf(now[key]))) {
      if (to === undefined) continue;
      if (!same(wasBag[field], to)) out.push({ field, custom: true, from: plain(wasBag[field]), to: plain(to) });
    }
  }
  return out;
}

/** An activity row's changes, when it has them (older rows do not). A row
 *  logged before the rule kept its derived columns; they are left out here,
 *  so no reader ever sees them. */
export function changesIn(diff: unknown): ActivityChange[] | null {
  const c = bagOf(diff).changes;
  return Array.isArray(c) ? (c as ActivityChange[]).filter((x) => x.custom || !isInternalField(x.field)) : null;
}
