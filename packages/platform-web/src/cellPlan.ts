// ONE source of truth for "can this field be edited in a grid cell, and if not,
// what do we tell the user." The decision half of EditableCell, kept pure and
// React-free (like fieldControl, whose control decision it builds on) so it can
// be asserted directly.
//
// The `switch (control)` is exhaustive over `FieldControl`: the `default:
// assertNever` turns a NEW control type into a COMPILE error, forcing whoever
// adds one to decide how a cell handles it. Without that gate a new control
// would inherit whatever the fallback happened to be — which is exactly how a
// boolean field once landed in a text box showing "false" at the form layer
// (see fieldControl). A grid multiplies that mistake by every row on screen.

import type { FieldRendererId, FieldType } from "./types";
import { fieldControl, type FieldControl } from "./fieldControl";

/** The minimum a cell needs to know about a field. A structural subset of
 *  PlatformFieldDef, so a real field-def passes as-is — but a NATIVE column
 *  (inventory's own `name`, `min_qty`, …) can describe itself with the same
 *  shape and get identical editing. Nothing here is module-specific. */
export interface EditableCellDef {
  name: string;
  display_label: string;
  type: FieldType;
  /** A required field can't be CLEARED from a cell — blanking it cancels the
   *  edit instead of committing a null the server would reject anyway. */
  required?: boolean | null;
  choices?: string[] | null;
  renderer?: FieldRendererId | null;
  unit?: string | null;
  server_managed?: boolean | null;
  ref_kind?: string | null;
}

export type CellPlan =
  | { kind: "locked"; reason: string }
  | { kind: "checkbox" }
  | { kind: "relation" }
  | { kind: "choice" }
  | { kind: "color" }
  | { kind: "input" };

function assertNever(x: never): never {
  throw new Error(`cellPlan: unhandled control ${JSON.stringify(x)}`);
}

/** Decide how a cell handles a field def. A `locked` plan is a promise the cell
 *  keeps: it renders the value read-only with `reason` on hover, and never an
 *  input the server would reject. */
export function cellPlan(def: EditableCellDef): CellPlan {
  const control: FieldControl = fieldControl(def);
  switch (control) {
    // Resolved server-side at read; there is no stored value to write.
    case "computed":
      return { kind: "locked", reason: "Computed automatically" };
    // Stamped server-side; the write router rejects a client value, so an input
    // would take a keystroke and silently revert.
    case "server-managed":
      return { kind: "locked", reason: "Set automatically" };
    // Needs the Write/Preview editor, which doesn't fit a cell. Say where to go
    // rather than offering a box that can't do the job.
    case "markdown":
      return {
        kind: "locked",
        reason: `Open the record to edit ${def.display_label.toLowerCase()}`,
      };
    case "checkbox":
      return { kind: "checkbox" };
    case "relation":
      return { kind: "relation" };
    case "choice":
      return { kind: "choice" };
    case "color":
      return { kind: "color" };
    case "number":
    case "date":
    case "url":
    case "text":
      return { kind: "input" };
    default:
      return assertNever(control);
  }
}
