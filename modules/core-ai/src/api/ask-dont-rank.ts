// An ambiguous name in a WRITE asks which one; it never ranks.
//
//   "I need a label on the CubePro"
//     -> list_records machines q="CubePro"   -> CubePro #9, CubePro #10
//     -> invoke_action labels:print on CubePro #10
//
// Two machines answered to the name and the sentence said nothing that
// picked one, so the model took the first search hit and printed a label
// for it, three times out of three (#3154, measured by the corpus case
// #3139 made deterministic). A label is paper, and paper is spent; every
// other wrong guess in the product costs a correction, this one costs a
// physical object with the wrong machine's name on it.
//
// It is the same family as #3141 and #3073: an action taken on a premise
// nobody confirmed. There the premise was a record that did not exist or a
// permission that was not held; here it is a record chosen by search order
// out of two equally good candidates, and the answer looks successful
// because nothing in it records that a choice was made.
//
// The rule is mechanical, so the model's judgement never decides it: the
// loop remembers every search it ran this turn and what came back. A write
// aimed at one record that came back from a search with company is asked
// whether the PERSON'S words pick it out: a token the chosen record carries
// (in its name or any field the search returned) that none of the other
// hits carry ("10"; "garage"). If they do, the choice was theirs and the
// write goes through. If they do not, the write is bounced with the
// candidates named, and the turn carries them as choices so the person can
// answer with one tap; the answer re-asks the same sentence with the record
// named, which is the draft preserved and the write resumed once.
//
// Reads are never judged: ranking freely for a read costs nothing. A write
// whose target the model did not get from a search this turn is not judged
// either (the person's page, an earlier turn): the loop cannot see its
// company, and a guard that fires on what it cannot see is a nag.
//
// Many candidates degrade to a narrowing question, not a wall of taps. Two
// CubePros are two taps; twenty parts matching "bolt" are the first six
// as taps, "and 14 more" said, and the model told to ask for a word that
// narrows it (a size, a place, a number) rather than to list them all. A
// parts bin is the first thing a real workshop produces.

import type { ToolCall } from "../providers/tool-wire.js";

/** One search the loop ran this turn and the records it returned. */
export interface SearchHits {
  /** The words searched for, as the model typed them. */
  q: string;
  hits: Array<{ id: string; label: string; text: string }>;
}

export interface Candidate {
  id: string;
  label: string;
}

export interface RankedNotAsked {
  message: string;
  ref: string;
  /** The first MAX_CHOICES, in the search's order. */
  candidates: Candidate[];
  /** How many more matched than are named. */
  more?: number;
}

/** A choice the person can tap: the record, and the sentence that picks it. */
export interface Choice {
  label: string;
  say: string;
}

/** The tools whose result is a search over records. */
const SEARCHES = new Set(["list_records", "search_records"]);

/** How many candidates are named and offered as taps; past this the question
 *  asks for a narrowing word instead of listing a parts bin. */
export const MAX_CHOICES = 6;

const STOP = new Set(["a", "an", "the", "of", "in", "on", "for", "to", "and", "or", "at", "by", "with", "it", "is", "my", "me", "i", "one", "this", "that"]);

/** Words and numbers, lowercased; "#10" reads as "10". */
export function tokensOf(s: string): Set<string> {
  const out = new Set<string>();
  for (const t of s.toLowerCase().split(/[^a-z0-9]+/)) if (t && !STOP.has(t)) out.add(t);
  return out;
}

/** Every string the record carries, at any depth a search result has. */
function textOf(v: unknown, depth = 0): string {
  if (v == null || depth > 3) return "";
  if (typeof v === "string") return v;
  if (typeof v === "number") return String(v);
  if (Array.isArray(v)) return v.map((x) => textOf(x, depth + 1)).join(" ");
  if (typeof v === "object") {
    return Object.entries(v as Record<string, unknown>)
      .filter(([k]) => k !== "id" && !/_id$/.test(k))
      .map(([, x]) => textOf(x, depth + 1))
      .join(" ");
  }
  return "";
}

const labelOf = (rec: Record<string, unknown>): string | null =>
  typeof rec.title === "string" ? rec.title : typeof rec.name === "string" ? rec.name : typeof rec.label === "string" ? rec.label : null;

/** What a read returned, when it was a search with company: two or more
 *  records for one `q`. Anything else is null and never judged. */
export function hitsFromSearch(name: string, args: Record<string, unknown>, result: unknown): SearchHits | null {
  if (!SEARCHES.has(name)) return null;
  const q = typeof args.q === "string" ? args.q.trim() : "";
  if (!q) return null;
  const body = (result as { data?: unknown } | null)?.data ?? result;
  const items = (body as { items?: unknown } | null)?.items;
  if (!Array.isArray(items)) return null;
  const hits: SearchHits["hits"] = [];
  for (const it of items) {
    if (!it || typeof it !== "object") continue;
    const rec = it as Record<string, unknown>;
    const id = typeof rec.id === "string" ? rec.id : null;
    const label = labelOf(rec);
    if (!id || !label?.trim()) continue;
    hits.push({ id, label, text: textOf(rec) });
  }
  return hits.length >= 2 ? { q, hits } : null;
}

/** The one record a write call is aimed at, or null (a create, a workspace
 *  action, a bulk write). */
export function targetOf(call: ToolCall): string | null {
  const a = (call.args ?? {}) as Record<string, unknown>;
  const raw = call.name === "invoke_action" ? a.entity_id : call.name === "update_record" || call.name === "delete_record" ? a.id : null;
  return typeof raw === "string" && raw.trim() ? raw.trim() : null;
}

/** The message to hand back, with the candidates, or null when the person's
 *  own words picked the record (or no search with company produced it). */
export function rankedNotAsked(userText: string, call: ToolCall, searches: readonly SearchHits[]): RankedNotAsked | null {
  const target = targetOf(call);
  if (!target) return null;
  const key = target.toLowerCase();
  const search = [...searches].reverse().find((s) => s.hits.some((h) => h.id.toLowerCase() === key));
  if (!search) return null;
  const chosen = search.hits.find((h) => h.id.toLowerCase() === key)!;
  const peers = search.hits.filter((h) => h.id.toLowerCase() !== key);
  if (peers.length === 0) return null;
  // What sets the chosen record apart from every other hit.
  const own = tokensOf(`${chosen.label} ${chosen.text}`);
  for (const p of peers) for (const t of tokensOf(`${p.label} ${p.text}`)) own.delete(t);
  const said = tokensOf(userText);
  for (const t of own) if (said.has(t)) return null;
  const a = (call.args ?? {}) as Record<string, unknown>;
  const what = call.name === "invoke_action" ? String(a.action_id ?? "the action") : call.name === "delete_record" ? "delete" : "update";
  const total = search.hits.length;
  const shown = search.hits.slice(0, MAX_CHOICES);
  const more = total - shown.length;
  const names = shown.map((h) => h.label).join(", ") + (more > 0 ? `, and ${more} more` : "");
  const how =
    more > 0
      ? `Ask them for a word that narrows it (a size, a place, a number) rather than listing them all; name a few and say how many there are.`
      : `Name the candidates in your answer and stop there; the write runs once they have chosen.`;
  return {
    message:
      `"${search.q}" matches ${total} records and the person's words do not say which: ${names}. ` +
      `Ask them which one before running ${what}; do not pick one for them. ${how}`,
    ref: search.q,
    candidates: shown.map((h) => ({ id: h.id, label: h.label })),
    ...(more > 0 ? { more } : {}),
  };
}

/** The taps that answer the question: each re-asks the person's own sentence
 *  with the record named, so the next turn carries the choice in the words
 *  the guard reads. The draft is the sentence; the resume is the re-ask. */
export function choicesFor(userText: string, ref: string, candidates: readonly Candidate[]): Choice[] {
  const at = userText.toLowerCase().indexOf(ref.toLowerCase());
  return candidates.map((c) => ({
    label: c.label,
    say: at >= 0 ? `${userText.slice(0, at)}${c.label}${userText.slice(at + ref.length)}` : `${userText} (${c.label})`,
  }));
}

/** The turn's guard, wired the way the chat loop wires it: feed every read
 *  it ran, ask before every write, and read the taps at the end. One object
 *  so the loop and its test hold the same three seams. */
export function askDontRank(userText: string): {
  onRead(name: string, args: Record<string, unknown>, result: unknown): void;
  validate(call: ToolCall): string | null;
  readonly choices: Choice[] | null;
} {
  const searches: SearchHits[] = [];
  let choices: Choice[] | null = null;
  return {
    onRead(name, args, result) {
      const hits = hitsFromSearch(name, args, result);
      if (hits) searches.push(hits);
    },
    validate(call) {
      const ranked = rankedNotAsked(userText, call, searches);
      if (!ranked) return null;
      choices = choicesFor(userText, ranked.ref, ranked.candidates);
      return ranked.message;
    },
    get choices() {
      return choices;
    },
  };
}
