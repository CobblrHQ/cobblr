// What an edit form sends: only the fields the person changed (#7906), and
// what those fields were when it opened (#7925).
//
// A form holds the record as it was when it opened. Sending every field back
// on Save wrote that old copy over whatever someone saved since: a rename in
// an older tab put back the shelf another tab had just moved, and both said
// saved. A field left as it was is not sent, so a newer value stands; a field
// this form changed carries its opened value, so the server refuses the save
// when someone changed that same field since (edited-from.ts).

import { EDITED_FROM_HEADER, encodeEditedFrom, sameStored } from "@cobblr/platform-contract/edited-from";

const bag = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});

/** The fields of `next` that differ from `opened`. Values compare as stored,
 *  so an array or object the form rebuilt with the same contents is unchanged,
 *  and an absent field and null are the same. */
export function changedFrom<T extends Record<string, unknown>>(opened: Partial<Record<keyof T, unknown>>, next: T): Partial<T> {
  const out: Partial<T> = {};
  for (const key of Object.keys(next) as (keyof T)[]) {
    if (!sameStored(next[key], opened[key])) out[key] = next[key];
  }
  return out;
}

/** A save from an edit form: the body holds only what changed (a `metadata`
 *  bag in `next` is judged key by key, and only its changed keys are sent),
 *  and the headers say what those fields were when the form opened. Pass both
 *  to the request; a save someone else's change would reverse is answered 409
 *  with who changed what. */
export function editOf<T extends Record<string, unknown>>(
  opened: Record<string, unknown>,
  next: T,
): { body: Partial<T>; headers: Record<string, string> } {
  const { metadata, ...fields } = next as Record<string, unknown>;
  const body = changedFrom(opened, fields) as Partial<T>;
  const was: Record<string, unknown> = Object.fromEntries(Object.keys(body).map((k) => [k, opened[k] ?? null]));
  if (metadata && typeof metadata === "object") {
    const before = bag(opened.metadata);
    const changed = Object.fromEntries(Object.entries(bag(metadata)).filter(([k, v]) => !sameStored(v, before[k])));
    if (Object.keys(changed).length) {
      (body as Record<string, unknown>).metadata = changed;
      was.metadata = Object.fromEntries(Object.keys(changed).map((k) => [k, before[k] ?? null]));
    }
  }
  return { body, headers: Object.keys(body).length ? { [EDITED_FROM_HEADER]: encodeEditedFrom(was) } : {} };
}
