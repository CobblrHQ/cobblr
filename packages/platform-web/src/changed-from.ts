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

declare const EDIT: unique symbol;

/** A save built by editOf: only the fields that changed, and what they were
 *  when the form opened. An update helper of a record takes this, never a bare
 *  body, so a form cannot send its old copy back unjudged (#7925). */
export type Edit<T> = { readonly body: Partial<T>; readonly headers: Record<string, string>; readonly [EDIT]: true };

/** A save from an edit form: the body holds only what changed (a `metadata`
 *  bag in `next` is judged key by key, and only its changed keys are sent),
 *  and the headers say what those fields were when the form opened. Hand it to
 *  the record's update helper; a save someone else's change would reverse is
 *  answered 409 with who changed what. `opened` is the record as the form
 *  showed it. */
export function editOf<T extends object>(opened: object | null | undefined, next: T): Edit<T> {
  const was0 = (opened ?? {}) as Record<string, unknown>;
  const { metadata, ...fields } = next as Record<string, unknown>;
  const body = changedFrom(was0, fields) as Record<string, unknown>;
  const was: Record<string, unknown> = Object.fromEntries(Object.keys(body).map((k) => [k, was0[k] ?? null]));
  if (metadata && typeof metadata === "object") {
    const before = bag(was0.metadata);
    const changed = Object.fromEntries(Object.entries(bag(metadata)).filter(([k, v]) => !sameStored(v, before[k])));
    if (Object.keys(changed).length) {
      body.metadata = changed;
      was.metadata = Object.fromEntries(Object.keys(changed).map((k) => [k, before[k] ?? null]));
    }
  }
  return { body: body as Partial<T>, headers: Object.keys(body).length ? { [EDITED_FROM_HEADER]: encodeEditedFrom(was) } : {} } as Edit<T>;
}
