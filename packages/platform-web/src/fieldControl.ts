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
  | "computed" // read-only, server-resolved every read (never stored)
  | "server-managed" // read-only, server-STAMPED stored value (client writes rejected)
  | "relation" // reference to another entity (picker over the def's ref_kind)
  | "member" // a person (picker over the workspace's members)
  | "color" // swatch picker
  | "choice" // dropdown (has a `choices` list)
  | "checkbox" // boolean
  | "number"
  | "date"
  | "url"
  | "markdown" // rich text — the Markdown editor (Write/Preview split)
  | "text";

function assertNever(x: never): never {
  throw new Error(`fieldControl: unhandled field type ${JSON.stringify(x)}`);
}

/** Decide the editing control for a field-def. Precedence: computed (locked) →
 *  server-managed (locked — the server owns the value; an input here would be a
 *  lying control that silently reverts) → boolean (checkbox) → an explicit
 *  colour renderer → a `choices` dropdown → then the storage type.
 *  Callers render the matching control; nobody re-derives this from `type`. */
export function fieldControl(def: {
  type: FieldType;
  renderer?: FieldRendererId | null;
  choices?: string[] | null;
  server_managed?: boolean | null;
}): FieldControl {
  if (def.type === "computed") return "computed";
  if (def.server_managed) return "server-managed";
  if (def.type === "relation") return "relation";
  // Before the `choices` check below: a member field has no static choices, and
  // falling through to a choice dropdown would render an empty one.
  if (def.type === "member") return "member";
  // Boolean outranks `choices`: on a boolean def, choices are the two DISPLAY
  // labels ([falseLabel, trueLabel] — what boolLabel renders), not selectable
  // values. A choice dropdown here would commit the label STRING into a boolean
  // key, which every boolean reader parses as false — the edit inverts itself
  // and corrupts the stored type.
  if (def.type === "boolean") return "checkbox";
  if (def.renderer === "color-hex") return "color";
  if (def.choices && def.choices.length > 0) return "choice";
  switch (def.type) {
    case "number":
      return "number";
    case "date":
      return "date";
    case "url":
      return "url";
    case "richtext":
      return "markdown";
    case "text":
      return "text";
    // `computed` / `relation` / `boolean` are handled by the early returns above
    // (TS narrows them out here). A NEW FieldType added to the union lands in
    // `default` and fails to compile against `never` — the durable guard.
    default:
      return assertNever(def.type);
  }
}
