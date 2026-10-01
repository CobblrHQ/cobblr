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
import { asMeasure } from "@cobblr/platform-contract/measure";
import { moneyForStorage, moneyInputText, moneyStorageOf, type MoneyFieldLike } from "@cobblr/platform-contract/money";

export type FieldControl =
  | "computed" // read-only, server-resolved every read (never stored)
  | "server-managed" // read-only, server-STAMPED stored value (client writes rejected)
  | "relation" // reference to another entity (picker over the def's ref_kind)
  | "member" // a person (picker over the workspace's members)
  | "person" // someone on the workspace's People list, member or not
  | "color" // swatch picker
  | "choice" // dropdown (has a `choices` list)
  | "checkbox" // boolean
  | "number"
  | "money" // an amount: MoneyInput, shown through formatMoney
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
  learns?: boolean | null;
} & MoneyFieldLike): FieldControl {
  if (def.type === "computed") return "computed";
  if (def.server_managed) return "server-managed";
  if (def.type === "relation") return "relation";
  // Before the `choices` check below: a member field has no static choices, and
  // falling through to a choice dropdown would render an empty one.
  if (def.type === "member") return "member";
  if (def.type === "person") return "person";
  // Boolean outranks `choices`: on a boolean def, choices are the two DISPLAY
  // labels ([falseLabel, trueLabel] — what boolLabel renders), not selectable
  // values. A choice dropdown here would commit the label STRING into a boolean
  // key, which every boolean reader parses as false — the edit inverts itself
  // and corrupts the stored type.
  if (def.type === "boolean") return "checkbox";
  if (def.renderer === "color-hex") return "color";
  // A text field that learns is picked from what it has used, list or not.
  if ((def.choices && def.choices.length > 0) || (def.type === "text" && def.learns === true)) return "choice";
  // A number whose role or unit says money is money, the same as a money field.
  if (moneyStorageOf(def)) return "money";
  switch (def.type) {
    case "number":
      return "number";
    case "money":
      return "money";
    case "date":
      return "date";
    case "url":
      return "url";
    case "richtext":
      return "markdown";
    case "text":
      return "text";
    // Typed as text ("4k7", "100 nF"); the server reads it into its value.
    case "measure":
      return "text";
    // `computed` / `relation` / `boolean` are handled by the early returns above
    // (TS narrows them out here). A NEW FieldType added to the union lands in
    // `default` and fails to compile against `never` — the durable guard.
    default:
      return assertNever(def.type);
  }
}

/** The stored value a typed string becomes, for a field of this type. The
 *  same two editors that share `fieldControl` used to turn the text of a
 *  number input into a value on their own: the detail panel stored
 *  `Number(text)`, the create modal stored the text. So "Good for (days)"
 *  typed on a new grocery was the string "10", every reader that checks
 *  `typeof === "number"` got nothing, and a restock from the shopping list
 *  dated no lot while the row promised one (2026-09-13). One rule, so a
 *  number field holds a number whichever door it came through. */
/** What an input shows for a stored value: a measured value as the person
 *  typed it ("4k7"), never "[object Object]"; anything else as text. */
export function fieldInputText(def: FieldValueDef, value: unknown): string {
  if (value == null) return "";
  if (def.type === "measure") return asMeasure(value)?.text ?? (typeof value === "string" ? value : "");
  const money = moneyStorageOf(def);
  if (money) return moneyInputText(value, money);
  return String(value);
}

/** What the value helpers read off a field: its type, and what makes it money
 *  (@cobblr/platform-contract/money). A field def passes as it is. */
export type FieldValueDef = { type: string } & MoneyFieldLike;

export function valueFromInput(def: FieldValueDef, text: string): unknown {
  if (text === "") return null;
  const type = def.type;
  // Money is stored the way its field stores it ("4,300" is 4300, or 430000
  // in a cents column); text that is not an amount is kept, for a person to fix.
  const money = moneyStorageOf(def);
  if (money) return moneyForStorage(text, money) ?? text;
  if (type === "number") {
    const n = Number(text);
    return Number.isFinite(n) ? n : null;
  }
  if (type === "boolean") return text === "true";
  return text;
}
