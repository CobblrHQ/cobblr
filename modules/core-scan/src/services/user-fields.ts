// Field values a person typed on a PENDING row, kept without filing it.
//
// The confirm form used to hold a typed value only until the card closed:
// Cancel, collapse, the sheet's previous/next or a reload lost it, and the
// row went back to what the matchmaker had read. "Review now, file later"
// then meant reviewing twice. PATCH /inbox/:id {fields} records the person's
// values in suggested_metadata.user_fields, and every reader of the top
// candidate's fields sees them merged over the model's: the served row (the
// card's chips, the form's seed, File N's body), the plan-first sweep
// (autofile), and the filing doors themselves (confirm, attach), so a value
// reaches the record whichever surface files it, with no extras from the
// caller. One rule, every door.
//
// The values are typed AGAINST A TABLE: "weight_class" means something on
// Yarn and nothing on a part. So they are stored with the kind they were
// typed for, and merged only while that kind is the top candidate. A re-run
// replaces the candidates and leaves the overrides alone; if it puts another
// table on top the values stay stored and stay off that table's fields, and
// they come back when the table does.
//
// Pure, so the rule is one function and testable: user over model, a null
// override deletes the key, nothing else on the candidate changes.
//
// The CATEGORY is kept here too, beside the values rather than among them. On
// a table whose axis is a custom field it is one of the values and needs
// nothing more; on a table whose module keeps its own categories (inventory's
// tree) there is no field to hold it, so a person's choice is the candidate's
// `category`, which every door already reads (#3223). Among the values it
// would be written back into the record as a field of that name: the second
// storage the join exists to end.

export type UserFieldValue = string | number | boolean;
export type UserFields = Record<string, UserFieldValue>;
/** What the row stores: the values and the table they were typed for. */
export interface StoredUserFields {
  kind: string | null;
  values: UserFields;
  /** The category the person chose, by name, for a table with no category
   *  field. Absent when they have not chosen one. */
  category?: string;
}

const KEY = "user_fields";

/** The person's overrides on a row's metadata, or null when there are none.
 *  Reads the {kind, values} shape and the earlier flat shape (no kind). */
export function userFieldsOf(meta: unknown): StoredUserFields | null {
  const raw = (meta as { user_fields?: unknown } | null | undefined)?.[KEY];
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const obj = raw as Record<string, unknown>;
  const flat = typeof obj.values === "object" && obj.values && !Array.isArray(obj.values) ? (obj.values as Record<string, unknown>) : obj;
  const kind = typeof obj.kind === "string" && obj.kind ? obj.kind : null;
  const values: UserFields = {};
  for (const [k, v] of Object.entries(flat)) {
    if (k === "kind" || k === "values") continue;
    if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") values[k] = v;
  }
  // Only the {kind, values} shape has a category beside its values; in the
  // flat shape a `category` key is a field somebody typed.
  const category = flat !== obj && typeof obj.category === "string" && obj.category.trim() ? obj.category.trim() : undefined;
  if (!Object.keys(values).length && !category) return null;
  return { kind, values, ...(category ? { category } : {}) };
}

/** Store what `stored` says, or drop the key when it says nothing. */
function withStored(meta: Record<string, unknown>, stored: StoredUserFields): Record<string, unknown> {
  const next = { ...meta };
  if (Object.keys(stored.values).length || stored.category) next[KEY] = stored;
  else delete next[KEY];
  return next;
}

/** `meta` with `patch` applied to its user_fields for `kind`: a value sets,
 *  null deletes. Typing against a different table than the stored values
 *  were typed for starts over: they were answers to another table's
 *  questions. Returns a NEW object; the caller stores it. */
export function applyUserFieldPatch(
  meta: Record<string, unknown>,
  patch: Record<string, UserFieldValue | null>,
  kind: string | null,
): Record<string, unknown> {
  const stored = userFieldsOf(meta);
  const sameTable = !stored || !stored.kind || !kind || stored.kind === kind;
  const cur: UserFields = sameTable ? { ...(stored?.values ?? {}) } : {};
  for (const [k, v] of Object.entries(patch)) {
    if (v === null || v === "") delete cur[k];
    else cur[k] = v;
  }
  const category = sameTable ? stored?.category : undefined;
  return withStored(meta, { kind: kind ?? stored?.kind ?? null, values: cur, ...(category ? { category } : {}) });
}

/** `meta` with the person's category for `kind` set, or cleared by null or
 *  "". Like the values, a category chosen for another table is dropped along
 *  with that table's answers. Returns a NEW object; the caller stores it. */
export function applyUserCategory(
  meta: Record<string, unknown>,
  category: string | null,
  kind: string | null,
): Record<string, unknown> {
  const stored = userFieldsOf(meta);
  const sameTable = !stored || !stored.kind || !kind || stored.kind === kind;
  const values: UserFields = sameTable ? { ...(stored?.values ?? {}) } : {};
  const next = category?.trim() ?? "";
  return withStored(meta, { kind: kind ?? stored?.kind ?? null, values, ...(next ? { category: next } : {}) });
}

/** The kind of a stored candidate ("yarn:item"), or null. */
export function candidateKind(c: unknown): string | null {
  const k = (c as { kind?: unknown } | null | undefined)?.kind;
  return typeof k === "string" && k ? k : null;
}

/** The candidate list with the person's values merged over the TOP
 *  candidate's fields, when the top candidate is the table they were typed
 *  for. Other candidates are untouched. */
export function candidatesWithUserFields<T>(candidates: T, meta: unknown): T {
  const user = userFieldsOf(meta);
  if (!user || !Array.isArray(candidates) || candidates.length === 0) return candidates;
  const [top, ...rest] = candidates as Array<Record<string, unknown>>;
  if (!top || typeof top !== "object") return candidates;
  const topKind = candidateKind(top);
  if (user.kind && topKind && user.kind !== topKind) return candidates;
  const fields = { ...((top.fields as Record<string, unknown> | undefined) ?? {}), ...user.values };
  return [{ ...top, fields, ...(user.category ? { category: user.category } : {}) }, ...rest] as unknown as T;
}
