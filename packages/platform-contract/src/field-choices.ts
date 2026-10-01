// When a field offers a list of choices, and when what a person types into it
// is remembered as one. ONE rule, read by the server (which learns) and by
// every picker (which offers), so the two never disagree.
//
// A choice field is a text field with choices, or one declared `learns`. It
// learns when it says so; a field that says nothing learns when it is a
// person's own (a bundle's or a module's field must declare it, and lint:field-learns-declared
// makes every shipped one a decision). A text field with no choices that
// never said it learns is a plain box: names, serials and notes stay free text
// and never grow a list. Learning is a person's typing; a value a parser read
// (a receipt, an import) is offered, never added on its own (arrivals.md).

export interface ChoiceFieldLike {
  type?: string | null;
  choices?: readonly string[] | null;
  /** Declared: true learns, false never does; null/undefined is the default. */
  learns?: boolean | null;
  /** Set on a field a bundle ships. */
  bundle_id?: string | null;
  /** Set on a field a module contributes. */
  source_module?: string | null;
}

/** Does this field remember what a person types as a new choice. */
export function choiceLearns(def: ChoiceFieldLike): boolean {
  if (def.type && def.type !== "text") return false;
  if (def.learns === true) return true;
  if (def.learns === false) return false;
  return !def.bundle_id && !def.source_module && (def.choices?.length ?? 0) > 0;
}

/** Is this field picked from a list (the combobox), rather than typed into a box. */
export function offersChoices(def: ChoiceFieldLike): boolean {
  if (def.type && def.type !== "text") return false;
  return (def.choices?.length ?? 0) > 0 || def.learns === true;
}

const norm = (s: string) => s.trim().replace(/\s+/g, " ").toLowerCase();

/** Values that differ only by case or spacing are one value. */
export function sameChoice(a: string, b: string): boolean {
  return norm(a) === norm(b);
}

/** The list with this value added, unless it is already there in any
 *  spelling; null when nothing would change. */
export function withLearnedChoice(choices: readonly string[] | null | undefined, value: string): string[] | null {
  const v = value.trim().replace(/\s+/g, " ");
  if (!v) return null;
  const list = [...(choices ?? [])];
  if (list.some((c) => sameChoice(c, v))) return null;
  return [...list, v];
}
