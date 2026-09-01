// The ENTITY KINDS lines of the system prompt, and the one thing they must
// not leave out: which declared fields the model CANNOT read.
//
// A kind's exposableFields is the allowlist of what leaves the module.
// Vendors expose name and website; machines do not expose notes. The route
// the tools read applies that projection, so a hidden field simply never
// arrives, and a model asked about it sees nothing and says "none". Correct
// by design, silently wrong in effect (a seeded kinematics in notes made
// "any deltas?" unanswerable from workspace data, 2026-08-27). So the prompt
// says which fields exist but are not readable here, and the rule below says
// what to do about a question that lands on one.

export interface KindLineRec {
  id: string;
  display_name?: string | null;
  fields?: Array<{ name: string }>;
  /** The kind's allowlist; null means everything declared is readable. */
  exposable_fields?: string[] | null;
}

/** Cross-cutting props every kind exposes whatever its allowlist says. */
const ALWAYS_READABLE = new Set(["id", "kind", "title", "subtitle", "image_path", "detailUrl", "instance", "name"]);

/** Declared fields the projection strips before the model can see them. */
export function hiddenFieldsOf(k: KindLineRec): string[] {
  if (!Array.isArray(k.exposable_fields)) return [];
  const allowed = new Set(k.exposable_fields);
  return (k.fields ?? []).map((f) => f.name).filter((n) => !allowed.has(n) && !ALWAYS_READABLE.has(n));
}

export function renderKindLines(kinds: KindLineRec[]): string {
  if (kinds.length === 0) return "(none)";
  return kinds
    .map((k) => {
      const hidden = hiddenFieldsOf(k);
      return `- ${k.id} (${k.display_name ?? k.id})${hidden.length ? ` — not readable here: ${hidden.join(", ")}` : ""}`;
    })
    .join("\n");
}

export const HIDDEN_FIELDS_RULE =
  "A field marked \"not readable here\" exists on the record but is hidden from you. Asked about one, say you cannot see that field from here and where it can be read (the record's own page) — never answer \"none\" or \"no\" from its absence.";

/** Whether the rule needs stating at all. */
export function anyHiddenFields(kinds: KindLineRec[]): boolean {
  return kinds.some((k) => hiddenFieldsOf(k).length > 0);
}
