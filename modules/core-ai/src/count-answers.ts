// Counting questions, answered before enter with no model in the room.
//
// live-answers.ts counts a KIND: "how many parts". The questions that went
// wrong on a phone (2026-08-27) count a VALUE inside a kind: "how many
// Bambus" (a brand), "any deltas?" (a type), "which model do I have the most
// of" (a group-by). A model answered "none" and "Cube" to a workspace with one
// Bambu and eight RailCores, because it was reading a partial page. Code does
// not read partial pages. count_records (the chat tool) already walks every
// record and counts by text or by field; this file recognises the sentence
// and hands it the same question, so there is one counting implementation.
//
// Same posture as live-answers: narrow, and it refuses rather than guesses.
// A needle under three letters, a field that exists on no kind or on several,
// a kind too big to count exactly - all null, and the AI gets the question as
// it always did.

import type { KindWords } from "./live-answers.js";

export interface KindFields extends KindWords {
  /** Exposed field names, as the tool result will carry them. */
  fields: string[];
}

export type CountQuestion =
  | { kind: "count-text"; needle: string; entityKind: string | null }
  | { kind: "most-of"; field: string; entityKinds: string[] };

const norm = (s: string): string =>
  s.toLowerCase().replace(/[^a-z0-9'\s]+/g, " ").replace(/\s+/g, " ").trim();

/** Words that name nothing on their own, so "how many things" is not a count of "things". */
const EMPTY_NOUN = /^(?:things?|items?|entries|stuff|of them|them|these|those|rec(?:ord)?s?)$/;

const singular = (w: string): string =>
  w.endsWith("ies") ? `${w.slice(0, -3)}y` : w.endsWith("ses") || w.endsWith("xes") ? w.slice(0, -2) : w.endsWith("s") ? w.slice(0, -1) : w;

/** The kind a phrase names, if exactly one does ("bambu printers" → machines
 *  via "printers"; the kind word is removed from the needle). */
function splitKind(phrase: string, kinds: KindWords[]): { needle: string; entityKind: string | null } | null {
  const words = phrase.split(" ");
  for (let i = words.length - 1; i >= 0; i--) {
    const w = words[i]!;
    const hits = kinds.filter((k) => norm(k.plural) === w || norm(k.singular) === w || norm(k.singular) === singular(w));
    if (hits.length === 1) {
      const needle = [...words.slice(0, i), ...words.slice(i + 1)].join(" ").trim();
      return { needle, entityKind: hits[0]!.id };
    }
    if (hits.length > 1) return null;
  }
  return { needle: phrase, entityKind: null };
}

/**
 * What is this asking to count, if anything?
 *
 * Runs AFTER readQuestionOf, so a plain "how many parts" (a kind) never gets
 * here; what does is "how many <something that is not a kind>".
 */
export function countQuestionOf(message: string, kinds: KindFields[]): CountQuestion | null {
  const m = norm(message);
  if (!m) return null;

  // "which model do I have the most of", "what manufacturer is most common",
  // "most common state among my machines"
  const most =
    /\b(?:which|what)\s+([a-z][a-z ]*?)\s+(?:do i have|have i got|is|are)\s+(?:the\s+)?most(?:\s+(?:of|common))?\b(?:\s+(?:among|in|across)\s+(?:my |the |our )?([a-z ]+?))?\s*\??$/.exec(m) ??
    /\bmost common\s+([a-z][a-z ]*?)(?:\s+(?:among|in|across|for)\s+(?:my |the |our )?([a-z ]+?))?\s*\??$/.exec(m);
  if (most) {
    const rawField = most[1]!.trim();
    const scope = most[2]?.trim();
    return mostOf(rawField, scope, kinds);
  }

  // "how many bambus", "how many bambu printers", "how many things mention pla"
  const howMany = /\bhow many\s+(?:of\s+(?:my|the|our)\s+)?([a-z0-9][a-z0-9' ]*?)(?:\s+(?:do|have|are|is|does|did|in|under|left|remain)\b.*)?\s*\??$/.exec(m);
  if (howMany) return countText(howMany[1]!.trim(), kinds);

  // "do I have any deltas", "any deltas?", "is there a delta", "are there any bambus"
  const TAIL = "(?:\\s+(?:left|here|at all|around|in stock|in (?:my |the )?[a-z ]+))?";
  const any =
    new RegExp(`^(?:do i have|have i got|is there|are there|got)\\s+(?:any\\s+|a\\s+|an\\s+)?([a-z0-9][a-z0-9' ]*?)${TAIL}\\s*\\??$`).exec(m) ??
    new RegExp(`^any\\s+([a-z0-9][a-z0-9' ]*?)${TAIL}\\s*\\??$`).exec(m);
  if (any) return countText(any[1]!.trim(), kinds);

  return null;
}

function countText(phrase: string, kinds: KindFields[]): CountQuestion | null {
  const split = splitKind(phrase, kinds);
  if (!split) return null;
  let needle = split.needle;
  // "things that mention pla" → "pla"; "bambus" → "bambu" (a brand pluralised
  // in speech is singular in the record).
  needle = needle.replace(/^(?:things?|items?|records?|stuff)\s+(?:that\s+)?(?:mention|say|contain|with)\s+/, "").trim();
  if (EMPTY_NOUN.test(needle)) return null;
  if (needle.length >= 4 && /[a-z]s$/.test(needle) && !needle.endsWith("ss")) needle = needle.slice(0, -1);
  if (needle.length < 3) return null;
  // The kind's own noun is not a value in it: "how many machines" is a kind
  // count that live-answers already declined, not a text search for "machine".
  return { kind: "count-text", needle, entityKind: split.entityKind };
}

function mostOf(rawField: string, scope: string | undefined, kinds: KindFields[]): CountQuestion | null {
  const field = norm(rawField).replace(/\s+/g, "_");
  const alt = norm(rawField).replace(/\s+/g, "");
  const inScope = scope ? kinds.filter((k) => norm(k.plural) === norm(scope) || norm(k.singular) === singular(norm(scope))) : kinds;
  if (scope && inScope.length !== 1) return null;
  const owners = inScope.filter((k) => k.fields.some((f) => f === field || f === alt || f === `${field}s`));
  if (owners.length === 0) return null;
  // Several kinds may declare the field (machines and assets both have a
  // manufacturer). Which one is meant is settled by which has records - the
  // executor counts each and answers only when exactly one does.
  const exact = owners[0]!.fields.find((f) => f === field || f === alt || f === `${field}s`)!;
  return { kind: "most-of", field: exact, entityKinds: owners.map((k) => k.id) };
}

/** What count_records returned, as the peek needs it. */
export interface CountResult {
  total: number;
  complete: boolean;
  groups?: Array<{ value: string; count: number }>;
}

const noun = (k: KindWords, n: number): string => (n === 1 ? k.singular : k.plural);

/** The sentence under the box for a text count, one kind. */
export function phraseCountText(q: Extract<CountQuestion, { kind: "count-text" }>, kind: KindWords, r: CountResult): { answer: string; detail: string } | null {
  if (!r.complete) return null;
  return {
    answer: r.total === 0 ? `no ${kind.plural} mention "${q.needle}"` : `${r.total} ${noun(kind, r.total)} mention${r.total === 1 ? "s" : ""} "${q.needle}"`,
    detail: "counted from your records, every field",
  };
}

/** The sentence for a group-by. */
export function phraseMostOf(q: Extract<CountQuestion, { kind: "most-of" }>, kind: KindWords, r: CountResult): { answer: string; detail: string } | null {
  if (!r.complete || !r.groups?.length) return null;
  const top = r.groups[0]!;
  if (top.value === "(blank)") return { answer: `most ${kind.plural} have no ${q.field.replace(/_/g, " ")} set`, detail: `${top.count} of ${r.total} are blank` };
  const runnerUp = r.groups[1];
  const tie = runnerUp && runnerUp.count === top.count;
  return {
    answer: tie ? `${top.value} and ${runnerUp.value} tie at ${top.count}` : `${top.value}: ${top.count} of ${r.total} ${kind.plural}`,
    detail: r.groups.slice(0, 4).map((g) => `${g.value} ${g.count}`).join(", "),
  };
}
