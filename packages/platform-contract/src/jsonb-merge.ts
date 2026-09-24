// A partial write to a record's jsonb bag (its custom fields, `metadata`) is
// a MERGE, decided here once: a key with a value is set, a key with null is
// removed, every other key is left as the row holds it at write time.
//
// Why it is one rule: three quick edits to one Home Inventory item (a value,
// where it was bought, when) each sent `{ metadata: { ...bagAsRendered,
// oneKey } }` and the server replaced the bag with it, so the last request's
// stale copy won and the other two answers were gone with a 200 each (#3625).
// The SQL that applies this plan is the kernel's (platform().db.mergeJsonb):
// one statement against the live row, never a read-then-write in JS.

export interface JsonbMergePlan {
  /** Keys to set, with their values. */
  set: Record<string, unknown>;
  /** Keys to remove. */
  remove: string[];
}

export function jsonbMergePlan(fields: Record<string, unknown>): JsonbMergePlan {
  const set: Record<string, unknown> = {};
  const remove: string[] = [];
  for (const [k, v] of Object.entries(fields)) {
    if (v === null || v === undefined) remove.push(k);
    else set[k] = v;
  }
  return { set, remove };
}

/** The same merge applied in memory: an after-image for an event, a cache. */
export function applyJsonbMerge(before: Record<string, unknown> | null | undefined, fields: Record<string, unknown>): Record<string, unknown> {
  const next = { ...(before ?? {}) };
  const plan = jsonbMergePlan(fields);
  for (const k of plan.remove) delete next[k];
  Object.assign(next, plan.set);
  return next;
}
