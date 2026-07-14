// Is the new-field form ready to submit — and if not, WHY?
//
// ONE source of truth, consumed by the submit button's `disabled`, the hint under
// it, and the submit handler's own guard. They cannot disagree, because they're
// the same function.
//
// This exists because they DID disagree. The button read
// `disabled={!entityKind || ...}`, but a field scoped to a CLASS of things has no
// entity_kind by design (the server derives the sentinel from the traits). So the
// button was dead in scope mode — permanently, silently, with no explanation of
// why. The form looked complete and simply refused to submit.
//
// Hence the second job: a disabled submit MUST be able to say what it's waiting
// for. A button that's greyed out with no reason is a dead end the user can't
// debug, and it's how a drifted rule hides.

import { isValidFieldKey } from "./field-key";

export interface FieldFormState {
  mode: "kind" | "scope";
  entityKind: string;
  scopeTraits: string[];
  name: string;
  label: string;
  type: string;
  template: string;
}

export interface Readiness {
  ok: boolean;
  /** What the form is waiting for. Null when ok. Shown next to the button, so
   *  "I can't click Add field" is never a mystery. */
  reason: string | null;
}

export function fieldFormReadiness(s: FieldFormState): Readiness {
  const no = (reason: string): Readiness => ({ ok: false, reason });

  if (!s.label.trim()) return no("give it a label");
  if (!s.name.trim()) return no("give it a key");
  if (!isValidFieldKey(s.name)) {
    return no("the key must be lowercase, start with a letter, and use only a-z 0-9 _");
  }
  if (s.mode === "kind" && !s.entityKind) return no("pick an entity kind");
  // In scope mode the entity_kind is DERIVED from the traits server-side, so it's
  // empty here on purpose. The traits are what must be present.
  if (s.mode === "scope" && s.scopeTraits.length === 0) {
    return no("pick at least one trait — a class with no traits lands on nothing");
  }
  if (s.type === "computed" && !s.template.trim()) {
    return no("a computed field needs a template, e.g. {{year}} {{manufacturer}}");
  }
  return { ok: true, reason: null };
}
