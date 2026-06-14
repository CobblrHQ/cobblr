// ONE source of truth for "which input control does a field-def get."
//
// There are two independent field editors (the inventory create modal's
// CustomFieldInput and the detail-page CustomFieldsPanel). They each used to
// switch on `def.type` on their own and drifted — the create modal grew a
// boolean checkbox, the edit panel didn't, so a `type:"boolean"` field rendered
// as a TEXT box showing "false" on the detail page. Both now route their
// control decision through `fieldControl()` so they can't disagree again.
//
// The `switch (type)` is exhaustive over `FieldType`: the `default: assertNever`
// turns a new/unhandled field type into a COMPILE error (caught by the typecheck
// CI job), which is the durable "detect when a field is the wrong type" guard.

import type { FieldType, FieldRendererId } from "./types";

export type FieldControl =
  | "computed" // read-only, server-resolved
  | "color" // swatch picker
  | "choice" // dropdown (has a `choices` list)
  | "checkbox" // boolean
  | "number"
  | "date"
  | "url"
  | "text";

function assertNever(x: never): never {
  throw new Error(`fieldControl: unhandled field type ${JSON.stringify(x)}`);
}

/** Decide the editing control for a field-def. Precedence: computed (locked) →
 *  an explicit colour renderer → a `choices` dropdown → then the storage type.
 *  Callers render the matching control; nobody re-derives this from `type`. */
export function fieldControl(def: {
  type: FieldType;
  renderer?: FieldRendererId | null;
  choices?: string[] | null;
}): FieldControl {
  if (def.type === "computed") return "computed";
  if (def.renderer === "color-hex") return "color";
  if (def.choices && def.choices.length > 0) return "choice";
  switch (def.type) {
    case "boolean":
      return "checkbox";
    case "number":
      return "number";
    case "date":
      return "date";
    case "url":
      return "url";
    case "text":
      return "text";
    // The `computed` member is handled by the early return above (TS narrows it
    // out here). A NEW FieldType added to the union lands in `default` and fails
    // to compile against `never` — the durable "unhandled field type" guard.
    default:
      return assertNever(def.type);
  }
}
