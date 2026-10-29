// Answering the question while it is still being typed.
//
// A read is safe to just DO. Nothing is written, nothing needs confirming, and
// the answer to "how many parts do I have?" is a number this workspace already
// knows — so making somebody press enter, wait for a model, and pay for a token
// to be told 47 is three costs for a fact that was sitting right there.
//
// So: recognise the handful of shapes people actually type, answer them from
// the workspace, and show it under the box before enter is pressed. No AI, and
// the answer is not a suggestion to run something — it IS the thing they were
// asking for.
//
// Deliberately narrow. A question this cannot answer is left alone and goes to
// the AI as it always did; a wrong number shown confidently is far worse than
// no number, so anything ambiguous (a noun matching two kinds, a name matching
// six records) declines rather than guesses.

import { keepWords, normQuestion } from "./question-text.js";
import { addDays, countdownWords, type Day } from "@cobblr/platform-contract/day";

/** A kind as the matcher needs to see it: its id and the words people use. */
export interface KindWords {
  id: string;
  /** "part", "location", "task" — singular, lowercase. */
  singular: string;
  /** "parts", "locations", "tasks". */
  plural: string;
}

export type Question =
  | { kind: "count"; entityKind: string }
  | { kind: "low-stock" }
  | { kind: "where"; name: string }
  | { kind: "attention" }
  | { kind: "due"; days: number; span: string };

const norm = normQuestion;

/** Match the noun somebody typed to exactly one kind, or nothing.
 *
 *  Exactly one: a workspace with both "parts" and "spare parts" cannot have
 *  "how many parts" answered confidently, and a confident wrong count is the
 *  failure this whole file is trying not to be. */
function kindFor(noun: string, kinds: KindWords[]): string | null {
  const n = norm(noun);
  if (!n) return null;
  const hits = kinds.filter((k) => norm(k.singular) === n || norm(k.plural) === n);
  return hits.length === 1 ? hits[0]!.id : null;
}

/**
 * What is this half-typed message asking for, if anything?
 *
 * Returns null for everything it does not recognise, which is most messages,
 * and is the correct answer: the AI is still there for the rest.
 */
export function readQuestionOf(message: string, kinds: KindWords[]): Question | null {
  const m = norm(message);
  if (!m) return null;

  // "what's low", "what is running low", "anything low on stock"
  if (/\b(what|anything|which)\b.*\b(low|running low|running out|out of stock)\b/.test(m) || /^low stock$/.test(m)) {
    return { kind: "low-stock" };
  }

  // "what needs my attention", "what needs doing", "anything for me"
  if (/\bneeds? (my )?(attention|doing|me)\b/.test(m) || /\bwhat should i (do|look at)\b/.test(m)) {
    return { kind: "attention" };
  }

  // "what's due this week", "anything due for service today", "what's coming
  // up this month": the calendar, read for a span. Asked before "where", which
  // would otherwise take "what's due" as a name to look for.
  if (/\b(what'?s|what is|what|anything|is anything|whats)\b.*\b(due|coming up|scheduled|needs? servic\w*)\b/.test(m)) {
    if (/\btoday\b/.test(m)) return { kind: "due", days: 0, span: "today" };
    if (/\b(this month|next month|next 30 days|in the next month)\b/.test(m)) return { kind: "due", days: 30, span: "in the next 30 days" };
    return { kind: "due", days: 7, span: /\bthis week\b/.test(m) ? "this week" : "in the next 7 days" };
  }

  // "how many parts (do I have)", "how many locations are there"
  const count = /\bhow many (\p{L}[\p{L}\p{M} ]*?)(?:\s+(?:do|have|are|is|does|did|in|under|left|remain)\b.*)?$/u.exec(m);
  if (count) {
    const id = kindFor(count[1]!.trim(), kinds);
    if (id) return { kind: "count", entityKind: id };
    return null;
  }

  // "where is my drill", "where's the blue spool", "where are my calipers"
  const where = /\bwhere(?:'s| is| are)?\s+(?:my |the |our )?(.+?)\s*\??$/i.exec(keepWords(message));
  if (where) {
    const name = where[1]!.trim();
    // Two words of slack: "where is it" and "where are they" name nothing.
    if (name.length >= 3 && !/^(it|they|them|this|that|those|these)$/i.test(name)) {
      return { kind: "where", name };
    }
  }
  return null;
}

/** How long a message must be before it is worth asking anything at all. A
 *  half-typed word matches nothing useful and costs a request per keystroke. */
export const MIN_PEEK_LENGTH = 8;

/** One dated thing as the due answer reads it (a calendar event). */
export interface DueEvent {
  title: string;
  date: string;
  /** "record": a date something happened, never due (date-field-direction.ts). */
  direction?: "due" | "record";
}

/** "What's due this week", said from the calendar: how many, then the first
 *  three by date with how far off each is. A date that records something is
 *  not due, so it is never counted. */
export function dueSaid(events: readonly DueEvent[], q: Extract<Question, { kind: "due" }>, today: Day): { answer: string; detail: string } {
  const until = addDays(today, q.days);
  const due = events
    .filter((e) => e.direction !== "record" && e.date.slice(0, 10) >= today && e.date.slice(0, 10) <= until)
    .sort((a, b) => a.date.localeCompare(b.date) || a.title.localeCompare(b.title));
  if (due.length === 0) return { answer: `Nothing is due ${q.span}`, detail: "nothing on the calendar for then" };
  const shown = due.slice(0, 3).map((e) => `${e.title}, ${countdownWords(e.date.slice(0, 10) as Day, today, "long")}`);
  const more = due.length > 3 ? `; and ${due.length - 3} more` : "";
  return { answer: `${due.length} due ${q.span}`, detail: shown.join("; ") + more };
}
