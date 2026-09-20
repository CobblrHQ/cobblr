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
//
// Two ways the first version walked past its own case (#3154, reopened):
//
// AMBIGUITY IS A PROPERTY OF THE CANDIDATES, NOT OF THE QUERY. The guard took
// hits from a list_records page only when the call carried `q`, so a model
// that listed every machine with no filter and picked one was not judged at
// all (the 2026-09-18 nightly). A listing is a search with an empty filter:
// its rows are judged the same way, with the reference worked out from the
// PERSON'S words instead of the model's `q` (the run of their words the
// chosen record's name carries, "CubePro"; failing that, its fields, the
// same name-first-then-any-field rule the tool itself searches by), and the
// company is every row that carries the same run.
//
// WHAT COUNTS AS PICKING ONE OUT IS EVERY FACT THE TURN READ, not the search
// row alone. "Take the CubePro out of the Garage" names the one in the
// Garage as plainly as "#9" would, but a placement is not a field on the
// row, so the guard asked again and the model, told only that two matched,
// answered "you have two CubePros in the Garage" (the 2026-09-19 nightly;
// the Garage held one). So the turn keeps what every read said about each
// record: where a placement read put it (list_related, either direction),
// and the whole record when it was fetched. A word from any of it picks the
// record out. And the bounce carries those facts by name ("CubePro #9 (in
// Garage)"), and says that the person's words are the question and not
// facts about the records, so a refusal never states a placement nobody
// read. A read that was not made is said as nothing, never as "nowhere".

import { PLACED_IN, placementAsked } from "@cobblr/workspace-tools";
import type { ToolCall } from "../providers/tool-wire.js";
import { recordsFromToolResult } from "./mentions.js";

/** One search the loop ran this turn and the records it returned. */
export interface SearchHits {
  /** The words searched for, as the model typed them; "" for a listing with
   *  no filter, whose company is worked out from the person's words. */
  q: string;
  hits: Array<{ id: string; label: string; text: string }>;
}

/** What the turn's other reads said about one record. */
export interface Facts {
  /** Where a placement read put it: the container's name; null when the read
   *  said it is placed nowhere. Absent when no read asked. */
  placed?: string | null;
  /** Every other string a read returned about it (the record fetched whole,
   *  the names of what is linked to it). */
  text: string[];
}

export interface Candidate {
  id: string;
  label: string;
  /** What the turn read about it, in a person's words: "in Garage". */
  note?: string;
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
  /** What the turn read about it, beside the name: "in Garage". */
  note?: string;
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
 *  records, for one `q` or for no filter at all. Anything else is null and
 *  never judged. */
export function hitsFromSearch(name: string, args: Record<string, unknown>, result: unknown): SearchHits | null {
  if (!SEARCHES.has(name)) return null;
  const q = typeof args.q === "string" ? args.q.trim() : "";
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

const factsOf = (facts: Map<string, Facts>, id: string): Facts => {
  let f = facts.get(id);
  if (!f) facts.set(id, (f = { text: [] }));
  return f;
};

/** What one read said about records beyond the rows a search returned: a
 *  placement (list_related, either direction) and a record fetched whole
 *  (get_record). `labels` is every record any read has named so far, so a
 *  container listed by id can be said by name. */
export function noteFacts(facts: Map<string, Facts>, labels: Map<string, string>, name: string, args: Record<string, unknown>, result: unknown): void {
  for (const r of recordsFromToolResult(result)) if (!labels.has(r.id)) labels.set(r.id, r.label);
  const body = (result as { data?: unknown } | null)?.data ?? result;
  const subject = typeof args.id === "string" ? args.id : "";
  if (name === "get_record" && subject && body && typeof body === "object") {
    factsOf(facts, subject).text.push(textOf(body));
    return;
  }
  if (name !== "list_related" || !subject) return;
  const items = (body as { items?: unknown } | null)?.items;
  if (!Array.isArray(items)) return;
  let container: string | null | undefined;
  for (const it of items) {
    if (!it || typeof it !== "object") continue;
    const row = it as Record<string, unknown>;
    const id = typeof row.id === "string" ? row.id : "";
    const title = typeof row.title === "string" ? row.title.trim() : "";
    if (!id) continue;
    if (title) factsOf(facts, subject).text.push(title);
    if (row.relationship !== PLACED_IN) continue;
    if (row.direction === "out") {
      // The subject is inside this one.
      container = title || labels.get(id) || "";
    } else if (row.direction === "in") {
      // This one is inside the subject.
      const holder = labels.get(subject);
      if (holder) {
        const f = factsOf(facts, id);
        f.placed = holder;
        f.text.push(holder);
      }
    }
  }
  if (container) {
    const f = factsOf(facts, subject);
    f.placed = container;
    f.text.push(container);
  } else if (container === undefined && placementAsked(args.relationship)) {
    // The tool looked for the subject's container and there was none: a fact
    // read, not a fact missing.
    factsOf(facts, subject).placed = null;
  }
}

/** The words of `userText` in order, with where each sits, stop words dropped. */
function wordsOf(userText: string): Array<{ t: string; start: number; end: number }> {
  const out: Array<{ t: string; start: number; end: number }> = [];
  for (const m of userText.matchAll(/[a-z0-9]+/gi)) {
    const t = m[0].toLowerCase();
    if (!STOP.has(t)) out.push({ t, start: m.index, end: m.index + m[0].length });
  }
  return out;
}

/** The longest run of the person's words that `carried` holds, as the
 *  substring they typed and as tokens; null when none of their words is
 *  there. The reference a listing is judged by. */
function runIn(userText: string, carried: ReadonlySet<string>): { ref: string; tokens: string[] } | null {
  const words = wordsOf(userText);
  let best: { from: number; to: number } | null = null;
  for (let i = 0; i < words.length; i++) {
    if (!carried.has(words[i]!.t)) continue;
    let j = i;
    while (j + 1 < words.length && carried.has(words[j + 1]!.t)) j++;
    if (!best || j - i > best.to - best.from) best = { from: i, to: j };
    i = j;
  }
  if (!best) return null;
  return {
    ref: userText.slice(words[best.from]!.start, words[best.to]!.end),
    tokens: words.slice(best.from, best.to + 1).map((w) => w.t),
  };
}

type Hit = SearchHits["hits"][number];

/** The company a write's target keeps in one search: the hits that answered
 *  the same reference. For a `q` search the tool already filtered by it and
 *  every hit is company. For a listing the reference is the run of the
 *  person's words the chosen record's NAME carries, and failing that its
 *  fields (the tool's own name-first-then-any-field rule); the company is
 *  every other row carrying the same run in the same place. */
function companyOf(userText: string, search: SearchHits, chosen: Hit): { ref: string; peers: Hit[] } | null {
  if (search.q) return { ref: search.q, peers: search.hits.filter((h) => h.id !== chosen.id) };
  const byName = runIn(userText, tokensOf(chosen.label));
  const where = byName ? (h: Hit) => tokensOf(h.label) : (h: Hit) => tokensOf(`${h.label} ${h.text}`);
  const run = byName ?? runIn(userText, tokensOf(`${chosen.label} ${chosen.text}`));
  if (!run) return null;
  const peers = search.hits.filter((h) => {
    if (h.id === chosen.id) return false;
    const has = where(h);
    return run.tokens.every((t) => has.has(t));
  });
  return { ref: run.ref, peers };
}

/** "in Garage" / "placed nowhere" for a record a placement read spoke of;
 *  nothing for one no read asked about. */
function noteOf(f: Facts | undefined): string | undefined {
  if (!f || f.placed === undefined) return undefined;
  return f.placed === null ? "placed nowhere" : `in ${f.placed}`;
}

/** The one record a write call is aimed at, or null (a create, a workspace
 *  action, a bulk write). */
export function targetOf(call: ToolCall): string | null {
  const a = (call.args ?? {}) as Record<string, unknown>;
  const raw = call.name === "invoke_action" ? a.entity_id : call.name === "update_record" || call.name === "delete_record" ? a.id : null;
  return typeof raw === "string" && raw.trim() ? raw.trim() : null;
}

/** The message to hand back, with the candidates, or null when the person's
 *  own words picked the record (or no search with company produced it).
 *  `facts` is what the turn's other reads said about each record, by id. */
export function rankedNotAsked(
  userText: string,
  call: ToolCall,
  searches: readonly SearchHits[],
  facts: ReadonlyMap<string, Facts> = new Map(),
): RankedNotAsked | null {
  const target = targetOf(call);
  if (!target) return null;
  const key = target.toLowerCase();
  const search = [...searches].reverse().find((s) => s.hits.some((h) => h.id.toLowerCase() === key));
  if (!search) return null;
  const chosen = search.hits.find((h) => h.id.toLowerCase() === key)!;
  const company = companyOf(userText, search, chosen);
  if (!company || company.peers.length === 0) return null;
  const { ref, peers } = company;
  // What sets the chosen record apart from every other hit: its row, and
  // everything else the turn read about it.
  const allOf = (h: Hit) => tokensOf(`${h.label} ${h.text} ${facts.get(h.id)?.text.join(" ") ?? ""}`);
  const own = allOf(chosen);
  for (const p of peers) for (const t of allOf(p)) own.delete(t);
  const said = tokensOf(userText);
  for (const t of own) if (said.has(t)) return null;
  const a = (call.args ?? {}) as Record<string, unknown>;
  const what = call.name === "invoke_action" ? String(a.action_id ?? "the action") : call.name === "delete_record" ? "delete" : "update";
  const all = search.hits.filter((h) => h.id === chosen.id || peers.includes(h));
  const total = all.length;
  const shown = all.slice(0, MAX_CHOICES);
  const more = total - shown.length;
  const candidates: Candidate[] = shown.map((h) => {
    const note = noteOf(facts.get(h.id));
    return { id: h.id, label: h.label, ...(note ? { note } : {}) };
  });
  const names = candidates.map((c) => (c.note ? `${c.label} (${c.note})` : c.label)).join(", ") + (more > 0 ? `, and ${more} more` : "");
  const how =
    more > 0
      ? `Ask them for a word that narrows it (a size, a place, a number) rather than listing them all; name a few and say how many there are.`
      : `Name the candidates in your answer and stop there; the write runs once they have chosen.`;
  return {
    message:
      `"${ref}" matches ${total} records and the person's words do not say which: ${names}. ` +
      `Ask them which one before running ${what}; do not pick one for them. ${how} ` +
      `Say only what the reads returned about them: the person's words are the question, not facts about these records, so do not say where one is unless a read said so.`,
    ref,
    candidates,
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
    ...(c.note ? { note: c.note } : {}),
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
  const facts = new Map<string, Facts>();
  const labels = new Map<string, string>();
  let choices: Choice[] | null = null;
  return {
    onRead(name, args, result) {
      const hits = hitsFromSearch(name, args, result);
      if (hits) searches.push(hits);
      noteFacts(facts, labels, name, args, result);
    },
    validate(call) {
      const ranked = rankedNotAsked(userText, call, searches, facts);
      if (!ranked) return null;
      choices = choicesFor(userText, ranked.ref, ranked.candidates);
      return ranked.message;
    },
    get choices() {
      return choices;
    },
  };
}
