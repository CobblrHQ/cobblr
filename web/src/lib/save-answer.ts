// Saving an Ask Cobb answer: where it should go, and the write that puts it
// there.
//
// There is one door for "save this", and it is the one Cobb already uses: a
// create_record write confirmed through /chat/execute, ledgered and undoable
// like any other change the chat makes. The Save button only proposes the
// destination and pre-fills the fields; it never grows a path of its own.
//   - A pattern (materials plus steps, in a workspace with Patterns) becomes a
//     Pattern. Its text is the pattern: the projects module reads the yarn,
//     hook and notions from it on the way in, with the same reader a PDF gets.
//   - Anything else becomes a Knowledge Base entry, which is also what Cobb
//     writes when asked to "save it as a knowledge entry".

/** A create proposal, the shape /chat/execute confirms. Declared here rather
 *  than imported from ./api so the API tests can build the exact write the
 *  button sends without pulling the browser client in; it is assignable to
 *  AiChatProposal. */
export interface CreateProposal {
  kind: "create";
  entity_kind: string;
  fields: Record<string, unknown>;
}

export type SaveDestination = "pattern" | "knowledge";

/** The Patterns collection the yarn bundle makes (projects, instance "designs"). */
export const PATTERNS_KIND = "designs:item";
export const KNOWLEDGE_KIND = "knowledge:entry";

// Crochet and knitting say what they are in a handful of words any pattern
// uses; one of them in the materials and one in the steps is a pattern.
const MATERIALS = /\b(materials|supplies|you will need|what you need|yarns?|hook|needles?)\b/i;
const YARN_OR_TOOL = /\b(yarn|skeins?|balls? of|worsted|dk|aran|bulky|fingering|sport weight|crochet hook|knitting needles?|\d+(?:\.\d+)?\s*mm\s+(?:crochet\s+)?(?:hook|needles?))\b/i;
const STEPS = /\b(ch(?:ain)?\s*\d+|sc|hdc|dc|tr|sl st|magic ring|rnd|round\s*\d+|row\s*\d+|cast on|k\d+|p\d+|knit|purl|fasten off|stitch(?:es)?)\b/i;

/** Does this answer read as a crochet or knitting pattern? */
export function looksLikePattern(text: string): boolean {
  return MATERIALS.test(text) && YARN_OR_TOOL.test(text) && STEPS.test(text);
}

/** Where Save proposes to put an answer. Always changeable by the person. */
export function saveDestination(text: string, hasPatterns: boolean): SaveDestination {
  return hasPatterns && looksLikePattern(text) ? "pattern" : "knowledge";
}

/** A title for the saved record: the answer's own heading if it has one,
 *  else its first bold line, else its first sentence, kept short. */
export function answerTitle(text: string): string {
  const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
  const heading = lines.find((l) => /^#{1,6}\s+\S/.test(l));
  if (heading) return clip(heading.replace(/^#{1,6}\s+/, "").replace(/[*_]/g, ""));
  const bold = lines.find((l) => /^\*\*[^*]+\*\*:?$/.test(l) && !/^\*\*(materials|instructions|notes?)/i.test(l));
  if (bold) return clip(bold.replace(/[*:]/g, ""));
  const first = (lines[0] ?? "").replace(/[*_#>`]/g, "");
  const sentence = first.split(/(?<=[.!?])\s/)[0] ?? first;
  return clip(sentence.replace(/[.!?:]+$/, "")) || "Saved from Ask Cobb";
}

function clip(s: string, max = 80): string {
  const t = s.trim();
  return t.length <= max ? t : `${t.slice(0, max - 1).trimEnd()}…`;
}

/** The line that says where a saved record came from. */
export function sourceLine(asked: string | null | undefined, when: Date): string {
  const date = when.toISOString().slice(0, 10);
  const q = asked?.trim() ? `, asked: "${clip(asked.trim().replace(/\s+/g, " "), 160)}"` : "";
  return `From Ask Cobb, ${date}${q}`;
}

/** An answer as plain words: a Pattern's description is a text box, where
 *  "## Materials" and "**Materials:**" would show their marks. Bullets and
 *  numbers stay, since they read as written. The Knowledge Base renders
 *  Markdown, so a note keeps it. */
export function plainText(text: string): string {
  return text
    .replace(/^[ \t]*#{1,6}[ \t]+/gm, "")
    .replace(/\*\*([^*\n]+)\*\*|__([^_\n]+)__/g, (_m, a: string | undefined, b: string | undefined) => a ?? b ?? "")
    .trim();
}

/** A Pattern's text lives in its description, which holds 8,000 characters. */
const PATTERN_BODY_MAX = 8000;

/** The confirmed write that saves the answer: Cobb's own create action. */
export function saveProposal(
  dest: SaveDestination,
  input: { title: string; text: string; asked?: string | null; when?: Date },
): CreateProposal {
  const when = input.when ?? new Date();
  const title = input.title.trim() || answerTitle(input.text);
  const from = sourceLine(input.asked, when);
  const provenance = { saved_from: "ask-cobb", saved_at: when.toISOString(), ...(input.asked?.trim() ? { asked: input.asked.trim().slice(0, 2000) } : {}) };
  if (dest === "pattern") {
    const body = plainText(input.text);
    return {
      kind: "create",
      entity_kind: PATTERNS_KIND,
      fields: {
        name: clip(title, 160),
        description: body.length <= PATTERN_BODY_MAX ? body : `${body.slice(0, PATTERN_BODY_MAX - 1)}…`,
        pattern_source: from,
        metadata: provenance,
      },
    };
  }
  return {
    kind: "create",
    entity_kind: KNOWLEDGE_KIND,
    fields: {
      title: clip(title, 300),
      body: `${input.text.trim()}\n\n---\n${from}`,
      kind: "Ask Cobb",
      metadata: provenance,
    },
  };
}

export const DESTINATION_LABEL: Record<SaveDestination, string> = {
  pattern: "Patterns",
  knowledge: "Knowledge Base",
};
