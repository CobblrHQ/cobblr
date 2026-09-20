// A record write never proposes a value a field cannot take.
//
//   "make a bin called Bin 4 in the garage"
//     -> create_record core-locations:location { kind: "bin", name: "Bin 4", parent_id: ... }
//     -> a card, confirmed, refused: Bad request body: kind (invalid enum
//        value. expected 'container' | 'area', received 'bin')
//
// The model saw the word "bin", guessed the kind and never read the kind's
// fields (2026-09-20). The confirm is the wrong place to find out: the person
// has already said yes, and what they read is a validator's sentence. The
// kinds carry their fixed values (a native field's `choices`, a custom
// dropdown's), so the write is checked against them here, before any card,
// and the model is handed the list to choose from, the way a missing action
// argument is handed back (action-args.ts). A field with no choices declared
// is not checked: a writer may still validate more tightly than the kinds say.
import type { ToolCall } from "../providers/tool-wire.js";

export interface FieldChoices {
  name: string;
  choices?: string[] | null;
}

export interface KindChoices {
  id: string;
  fields?: FieldChoices[];
  custom_fields?: FieldChoices[];
}

/** The fields a create/update call is writing, however the call spells it. */
function fieldsOf(call: ToolCall): Record<string, unknown> {
  const args = (call.args ?? {}) as Record<string, unknown>;
  const fields = args.fields;
  return fields && typeof fields === "object" && !Array.isArray(fields) ? (fields as Record<string, unknown>) : {};
}

/** The message to hand back, or null when every value is one the field takes. */
export function outsideChoices(call: ToolCall, kinds: readonly KindChoices[]): string | null {
  if (call.name !== "create_record" && call.name !== "update_record") return null;
  const args = (call.args ?? {}) as Record<string, unknown>;
  const kind = kinds.find((k) => k.id === String(args.kind ?? ""));
  if (!kind) return null;
  const declared = [...(kind.fields ?? []), ...(kind.custom_fields ?? [])].filter((f) => f.choices?.length);
  for (const [name, value] of Object.entries(fieldsOf(call))) {
    if (typeof value !== "string" || !value.trim()) continue;
    const f = declared.find((d) => d.name === name);
    if (!f) continue;
    const choices = f.choices!;
    // Case is the person's, not the field's: "Container" is container.
    const hit = choices.find((c) => c.toLowerCase() === value.trim().toLowerCase());
    if (hit) {
      if (hit !== value) (args.fields as Record<string, unknown>)[name] = hit;
      continue;
    }
    return `${name} must be one of: ${choices.join(", ")} (got "${value}"). Pick the closest, or ask the person which.`;
  }
  return null;
}
