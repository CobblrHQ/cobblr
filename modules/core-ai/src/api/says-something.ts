// What a person is handed at the end of a Cobb turn: always words, and never
// a tool's own.
//
// "remove tea category from inventory" was answered with "entity_kind and
// field are required" and, asked again, with nothing at all (#4574). Both are
// the same failure seen from the reader's side: a sentence written for the
// model reached the person, or no sentence reached them. The model is told
// not to do either; this is the part that does not depend on it complying,
// the same way scrub-ids.ts takes ids out of an answer.

/** The kinds a turn knows, so "inventory:part" can be said as "parts". */
export interface KindWord {
  id: string;
  display_name?: string | null;
  display_name_plural?: string | null;
}

/** The sentence a turn ends on when it would otherwise end on nothing. */
export const NOTHING_SAID =
  "I couldn't put an answer together for that one. Nothing was changed. Try asking again, or in a different way.";

const ARG = /[a-z][a-z0-9]*(?:_[a-z0-9]+)+/;
const KIND_ID = /\b[a-z][a-z0-9-]*:[a-z][a-z0-9_-]*\b/g;

function kindSaid(id: string, kinds: readonly KindWord[]): string | null {
  const k = kinds.find((x) => x.id === id);
  if (!k) return null;
  const many = (k.display_name_plural ?? "").trim() || (k.display_name ?? "").trim();
  return many ? many.toLowerCase() : null;
}

/**
 * A refusal or an answer, in the words a person reads.
 *
 * - a kind's id becomes what the workspace calls it ("parts");
 * - an argument name in brackets, the model's hint, goes: "say which kind of
 *   record (entity_kind)" reads as "say which kind of record";
 * - "entity_kind and field are required" becomes "I need to know the kind of
 *   record and the field".
 */
export function inPlainWords(text: string, kinds: readonly KindWord[] = []): string {
  if (!text) return text;
  let out = text.replace(KIND_ID, (id) => kindSaid(id, kinds) ?? id);
  out = out.replace(new RegExp(`\\s*\\(\\s*${ARG.source}\\s*\\)`, "g"), "");
  out = out.replace(
    new RegExp(`\\b(${ARG.source}(?:\\s*(?:,|and|or)\\s*(?:${ARG.source}|[a-z]+))*)\\s+(?:is|are)\\s+required\\b`, "gi"),
    (_m, names: string) => `I need to know ${names.split(/\s*(?:,|\band\b|\bor\b)\s*/).filter(Boolean).map(argWords).join(" and ")}`,
  );
  return out.replace(/[ \t]{2,}/g, " ").trim();
}

/** "entity_kind" → "the kind of record", "field" → "the field". */
function argWords(name: string): string {
  const n = name.trim().toLowerCase();
  if (n === "entity_kind" || n === "kind") return "the kind of record";
  if (n === "entity_id" || n === "id" || n === "ids") return "which record";
  return `the ${n.replace(/_/g, " ")}`;
}

type Result = Record<string, unknown> & { type?: unknown; text?: unknown; items?: unknown; proposal?: unknown };

const blank = (v: unknown) => typeof v !== "string" || v.trim() === "";

/**
 * Every turn ends with something to read. A reply with no words gets the one
 * sentence that says so; a card is something to read already. Its words, and
 * a reply's, go through inPlainWords.
 */
export function saysSomething(result: unknown, kinds: readonly KindWord[] = []): unknown {
  if (!result || typeof result !== "object") return { type: "reply", text: NOTHING_SAID };
  const r = result as Result;
  const cards = r.type === "proposal" ? (r.proposal ? 1 : 0) : r.type === "proposals" && Array.isArray(r.items) ? r.items.length : 0;
  const applied = Array.isArray(r.applied) ? r.applied.length : 0;
  if (typeof r.text === "string") r.text = inPlainWords(r.text, kinds);
  if ((r.type === "reply" || ((r.type === "proposal" || r.type === "proposals") && cards === 0)) && blank(r.text) && applied === 0) {
    return { ...r, type: "reply", text: NOTHING_SAID };
  }
  return r;
}
