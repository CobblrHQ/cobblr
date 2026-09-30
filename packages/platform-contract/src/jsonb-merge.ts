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

/** The merge patch that turns `from` into `to`: every key whose value changed,
 *  and null for every key `to` no longer has. A caller that computes the WHOLE
 *  bag it wants (a geometry helper that deletes a key when nothing is left in
 *  it) must send this, not the bag: under the merge a missing key is "leave
 *  it", so a deleted key came straight back and "take it off the plan" never
 *  stuck (#4195). */
export function jsonbPatchBetween(from: Record<string, unknown> | null | undefined, to: Record<string, unknown>): Record<string, unknown> {
  const before = from ?? {};
  const patch: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(to)) if (JSON.stringify(before[k]) !== JSON.stringify(v)) patch[k] = v;
  for (const k of Object.keys(before)) if (!(k in to) || to[k] === undefined) patch[k] = null;
  return patch;
}
