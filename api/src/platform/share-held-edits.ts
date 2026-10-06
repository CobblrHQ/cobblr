// A friend's edit that lands while the mirror is writing the owner's change
// onto the same copy (share-mirror.ts, mirror.upsert). The mirror reads the
// copy, writes the owner's values over it and records what it left as the
// base: an edit between the read and the write is overwritten, and one after
// the write is folded into the base. Either way it never went back, so the
// owner never saw the conflict. These are the repairs that keep it.

export type Bags = { fields: Record<string, unknown>; metadata: Record<string, unknown> };

/** One person's write to the copy during the apply, from the activity log. */
export interface PersonWrite {
  diff: unknown;
}

const flat = (diff: unknown): Array<[string, unknown]> => {
  if (!diff || typeof diff !== "object") return [];
  const out: Array<[string, unknown]> = [];
  for (const [k, v] of Object.entries(diff as Record<string, unknown>)) {
    if (k === "metadata" && v && typeof v === "object" && !Array.isArray(v)) out.push(...Object.entries(v as Record<string, unknown>));
    else out.push([k, v]);
  }
  return out;
};

/** Given the base before the apply, the base the apply recorded, and the
 *  person's writes during it (oldest first): the values to put back on the
 *  copy (the person's, last one wins) and the base each such field goes back
 *  measured from (what the person's edit was based on), so it is sent to the
 *  owner's side, which sees the owner changed it too: a conflict. Fields the
 *  share does not carry are not the mirror's to repair. `sent` is the base
 *  as it stood just before the mirror recorded its own. */
export function editsMadeDuringApply(writes: PersonWrite[], before: Bags, after: Bags, sent: Bags = { fields: {}, metadata: {} }): { restore: Bags; base: Bags } {
  const restore: Bags = { fields: {}, metadata: {} };
  const base: Bags = { fields: {}, metadata: {} };
  for (const w of writes) {
    for (const [k, v] of flat(w.diff)) {
      const bag = k in after.metadata ? "metadata" : k in after.fields ? "fields" : null;
      if (!bag) continue;
      restore[bag][k] = v;
      base[bag][k] = k in before[bag] ? before[bag][k] : after[bag][k];
    }
  }
  // An edit that already went back while the mirror ran (the base said so
  // before the mirror recorded its own) reached the owner: nothing to keep.
  for (const bag of ["fields", "metadata"] as const)
    for (const k of Object.keys(restore[bag]))
      if (k in sent[bag] && JSON.stringify(sent[bag][k] ?? null) === JSON.stringify(restore[bag][k] ?? null)) {
        delete restore[bag][k];
        delete base[bag][k];
      }
  return { restore, base };
}
