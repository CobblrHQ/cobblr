// A create is never offered without what the kind requires.
//
//   "Add a part called Audit spacer desktop, quantity 7, unit pieces, in Blue drawer."
//     -> create_record inventory:part { qty: 7, unit: "pieces" }
//     -> a card "Create a part", confirmed, refused: Name is missing.: name (required)
//
// The model dropped the name it had been given (2026-10-22, #7895). The
// confirm is the wrong place to find out: the person has already said yes to
// a card that could never run. The kinds say which fields a create needs, so
// the call is checked here, before any card, and the model is handed what is
// missing, the way a value outside a field's choices is (field-choices.ts).
import { withArticle } from "@cobblr/platform-contract/plural";
import { withKindsTitleField, type KindRec } from "@cobblr/workspace-tools";
import type { ToolCall } from "../providers/tool-wire.js";

const capitalize = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);

const blank = (v: unknown): boolean => v === undefined || v === null || (typeof v === "string" && !v.trim());

/** The required fields a create call leaves without a value, by name. */
export function missingRequired(call: ToolCall, kinds: KindRec[]): string[] {
  if (call.name !== "create_record") return [];
  const args = (call.args ?? {}) as Record<string, unknown>;
  const kind = String(args.kind ?? "");
  const rec = kinds.find((k) => k.id === kind);
  if (!rec) return [];
  const given = args.fields && typeof args.fields === "object" && !Array.isArray(args.fields) ? (args.fields as Record<string, unknown>) : {};
  // "title" for a kind that says "name" is the same value under another
  // word, and the create accepts it (withKindsTitleField), so it counts.
  const { fields } = withKindsTitleField(kind, kinds, given);
  const required = [...(rec.fields ?? []).filter((f) => f.required && !f.readOnly), ...(rec.custom_fields ?? []).filter((f) => f.required)];
  return required.filter((f) => blank(fields[f.name])).map((f) => f.name);
}

/** The message to hand the model, or null when every required field has a value. */
export function missingOnCreate(call: ToolCall, kinds: KindRec[]): string | null {
  const missing = missingRequired(call, kinds);
  if (!missing.length) return null;
  const kind = String((call.args ?? {}).kind ?? "");
  const noun = (kinds.find((k) => k.id === kind)?.display_name ?? kind).toLowerCase();
  return `${capitalize(withArticle(noun))} needs ${missing.map((n) => `fields.${n}`).join(", ")}, and this call has no value for ${missing.length === 1 ? "it" : "them"}. Use what the person said (a name they gave is the name), or ask them.`;
}
