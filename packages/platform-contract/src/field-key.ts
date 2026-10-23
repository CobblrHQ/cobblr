// The key a field is stored under: one rule, for the server that refuses a bad
// one and for every place that derives one from a label (#7879).
//
// A choice field's one-off clarifier lives at `<name>_note` in metadata
// (packages/platform-web/src/field-note.ts), so a real field named
// `<anything>_note` would fight the clarifier of the field it shadows for one
// key. The server refuses such a name. A label that ends in "note" ("Batch
// note") made exactly that name from the ordinary slugging, so the form
// enabled Add field and the server answered 400 over a rule the person never
// typed. A key derived from a label goes through `clearOfReservedKey`.

export const FIELD_KEY_PATTERN = /^[a-z][a-z0-9_]*$/;

/** What a choice field's clarifier takes after the field's own key. */
export const CLARIFIER_SUFFIX = "_note";

export function isReservedFieldKey(key: string): boolean {
  return key.endsWith(CLARIFIER_SUFFIX);
}

/** Whether the server will accept this as a field's key. */
export function isValidFieldKey(key: string): boolean {
  return FIELD_KEY_PATTERN.test(key) && !isReservedFieldKey(key);
}

/** A derived key that is not the reserved one: "batch_note" -> "batch_note_text". */
export function clearOfReservedKey(key: string): string {
  return isReservedFieldKey(key) ? `${key}_text` : key;
}
