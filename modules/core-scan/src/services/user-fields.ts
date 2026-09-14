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

export type UserFieldValue = string | number | boolean;
export type UserFields = Record<string, UserFieldValue>;
/** What the row stores: the values and the table they were typed for. */
export interface StoredUserFields {
  kind: string | null;
  values: UserFields;
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
  return Object.keys(values).length ? { kind, values } : null;
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
  const next = { ...meta };
  if (Object.keys(cur).length) next[KEY] = { kind: kind ?? stored?.kind ?? null, values: cur } satisfies StoredUserFields;
  else delete next[KEY];
  return next;
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
  return [{ ...top, fields }, ...rest] as unknown as T;
}
