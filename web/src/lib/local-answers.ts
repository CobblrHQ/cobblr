// Questions the tab can answer without asking anyone.
//
// "what page am I on?" went to the server, came back null, and then would have
// gone to a model — for a fact the browser was already holding. The page
// publishes its own context for Cobb's prompt (chat-context.ts), so the answer
// was one function call away the whole time, and no request is even the right
// number of requests to make for it.
//
// This is the innermost of three rings, and the order is the point:
//   1. here      — the tab already knows it. Instant, no request.
//   2. /peek     — the workspace knows it. One read, no model.
//   3. the model — everything else, on enter, as before.

import type { ChatPageContext } from "./chat-context";

export interface LocalAnswer {
  answer: string;
  detail?: string;
}

const norm = (s: string): string =>
  s.toLowerCase().replace(/[^a-z0-9'\s]+/g, " ").replace(/\s+/g, " ").trim();

/**
 * Answer from what this tab knows, or null to let the outer rings try.
 *
 * Narrow like the others: a wrong answer shown before anybody pressed enter is
 * worse than no answer, and "where am I" has exactly one right answer here.
 */
export function localAnswerFor(message: string, page: ChatPageContext | null): LocalAnswer | null {
  const m = norm(message);
  if (!m) return null;

  // "what page am I on", "where am I", "what am I looking at", "what is this
  // screen" — one question, many ways of asking it.
  const asksWhere =
    /\bwhat (page|screen|view) (am i on|is this|am i looking at)\b/.test(m) ||
    /\bwhere am i\b/.test(m) ||
    /\bwhat am i (looking at|on)\b/.test(m) ||
    /\bwhat is this (page|screen|view)\b/.test(m);
  if (asksWhere) {
    // No published context means no honest answer: a page that says nothing
    // about itself is one this cannot name.
    if (!page?.label) return null;
    return { answer: page.label, ...(page.summary ? { detail: page.summary } : {}) };
  }

  // "what's on this page", "what am I seeing here" — the SUMMARY is the answer,
  // and without one there is nothing to say that the label did not already.
  if (/\bwhat(?:'s| is| are)?\b.*\b(on|in) (this|the) (page|screen|view)\b/.test(m) || /\bwhat am i seeing\b/.test(m)) {
    if (!page?.summary) return null;
    return { answer: page.summary, detail: `on ${page.label}` };
  }

  return null;
}
