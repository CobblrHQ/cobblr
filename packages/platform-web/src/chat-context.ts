// Page context for Ask Cobb. The screen the user is looking at publishes a short
// summary of itself; the chat widget reads it at send-time and passes it to the
// chat endpoint, which injects it into Cobb's system prompt for situational
// relevance ("you're on the Scan Inbox — 19 pending, 16 waiting 2d+"). Lives in
// platform-web so BOTH core pages and module UIs can publish. Read at send-time
// (no React re-render plumbing): a page just publishes while mounted.

import { useEffect, useState } from "react";

export interface ChatPageContext {
  /** Human page name, e.g. "Scan Inbox". */
  label: string;
  /** One-line state of what's on screen, e.g. "19 pending, 16 waiting 2d+". */
  summary?: string;
}

let current: ChatPageContext | null = null;

/** What Cobb should be told the user is looking at right now (or null). */
export function getChatPageContext(): ChatPageContext | null {
  return current;
}

/** A page publishes its context for as long as it's mounted; cleared on unmount.
 *  Cleanup only clears if WE are still the current publisher, so a page that
 *  unmounts AFTER the next page mounted (route transition) can't clobber it. */
export function usePublishChatContext(ctx: ChatPageContext | null): void {
  const label = ctx?.label ?? "";
  const summary = ctx?.summary ?? "";
  useEffect(() => {
    const mine: ChatPageContext | null = label ? { label, ...(summary ? { summary } : {}) } : null;
    current = mine;
    return () => {
      if (current === mine) current = null;
    };
  }, [label, summary]);
}

// ── What the user has SELECTED ───────────────────────────────────────────────
//
// The page context above says which screen someone is on. This says which
// THINGS on it they are pointing at, which is the difference between Cobb
// knowing you are on Locations and Cobb knowing you mean these twelve racks.
//
// Two slots, not one, because they come from different acts and a person can
// do both: a page publishes the rows a person ticked, and a highlight is
// captured from the document. Rows win when both exist — ticking a box is more
// deliberate than dragging across a label.
//
// Selections are STICKY on purpose. Clicking into the chat box collapses the
// browser's own highlight (the caret moves into the textarea), so a selection
// that lived only in the DOM was gone by the time anyone typed about it. This
// keeps it until it is used, dismissed, or replaced.

export interface ChatSelection {
  /** What the chip calls it: "12 locations", "Rack 1", "Selected text". */
  label: string;
  /** The kind and ids, when the page knows them. This is what makes a
   *  selection something Cobb can ACT on rather than merely read. */
  kind?: string;
  ids?: string[];
  /** The words themselves, when a highlight is all there is. */
  text?: string;
}

let rows: ChatSelection | null = null;
let text: ChatSelection | null = null;
const listeners = new Set<() => void>();

function announce(): void {
  for (const l of listeners) {
    try {
      l();
    } catch {
      /* a broken subscriber must not stop the others */
    }
  }
}

/** The selection Cobb should be told about: ticked rows if there are any,
 *  otherwise whatever is highlighted. */
export function getChatSelection(): ChatSelection | null {
  return rows ?? text;
}

/** A page publishes the rows a person has ticked, for as long as it has them. */
export function publishRowSelection(sel: ChatSelection | null): void {
  rows = sel;
  announce();
}

/** The captured highlight. Separate slot so it cannot clobber ticked rows. */
export function publishTextSelection(sel: ChatSelection | null): void {
  text = sel;
  announce();
}

/** Forget both — after the message that used them is sent, or on dismiss. */
export function clearChatSelection(): void {
  rows = null;
  text = null;
  announce();
}

/** Subscribe to selection changes; returns an unsubscribe. The chip has to
 *  appear as it happens, unlike page context which is only read at send-time. */
export function subscribeChatSelection(l: () => void): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}

/** The current selection, as React state. */
export function useChatSelection(): ChatSelection | null {
  const [sel, setSel] = useState<ChatSelection | null>(getChatSelection());
  useEffect(() => subscribeChatSelection(() => setSel(getChatSelection())), []);
  return sel;
}

/** A page publishes its ticked rows while it has them, and takes them back on
 *  unmount — a selection on a screen nobody is looking at is not a selection. */
export function usePublishRowSelection(sel: ChatSelection | null): void {
  const key = sel ? `${sel.label}|${sel.kind ?? ""}|${(sel.ids ?? []).join(",")}` : "";
  useEffect(() => {
    publishRowSelection(key && sel ? sel : null);
    return () => publishRowSelection(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
}

// ── A highlight names a THING, not a string ─────────────────────────────────
//
// Highlighting "Rack 1" and asking to delete duplicates got: "there's only one
// location named Rack 1". Correct, and useless — the duplicates were the two
// Shelf 1s INSIDE it. The selection had been sent as the word, so it was read
// as the subject to search for rather than the record to look in.
//
// A page knows what it is showing, so it can turn the words back into the
// record: the chip then carries a kind and an id, and Cobb works on the thing.

export interface ResolvedSelection {
  kind: string;
  id: string;
  label: string;
}

let resolver: ((text: string) => ResolvedSelection | null) | null = null;

/** What the highlighted words refer to on this page, if anything. */
export function resolveSelectionText(text: string): ResolvedSelection | null {
  try {
    return resolver?.(text) ?? null;
  } catch {
    return null;
  }
}

/** A page offers to translate a highlight into one of its records, while it is
 *  mounted. Cheap and exact-match by design: a fuzzy guess that resolves to the
 *  wrong record is worse than sending the words. */
export function useSelectionResolver(fn: ((text: string) => ResolvedSelection | null) | null): void {
  useEffect(() => {
    resolver = fn;
    return () => {
      if (resolver === fn) resolver = null;
    };
  }, [fn]);
}

/** The one-liner every list uses to publish what is ticked.
 *
 *  Wrapping `usePublishRowSelection` rather than leaving each page to build the
 *  object keeps the wording the same everywhere ("12 parts", not "12 selected"
 *  on one screen and "parts: 12" on the next), and means a page adopts this in
 *  one line instead of ten. The KIND is the part a page must get right: it is
 *  what turns a chip into something Cobb can act on. */
export function usePublishSelectedRecords(
  selected: ReadonlySet<string>,
  rows: ReadonlyArray<{ id: string; name?: string | null; title?: string | null }>,
  kind: string,
  /** What one of them is called, in a person's words: "part", "asset". */
  noun: string,
): void {
  const ids = [...selected];
  const names = rows.filter((r) => selected.has(r.id)).map((r) => r.title ?? r.name ?? "");
  usePublishRowSelection(
    ids.length
      ? {
          label: ids.length === 1 ? (names[0] || `1 ${noun}`) : `${ids.length} ${noun}s`,
          kind,
          ids,
          ...(names.some(Boolean) ? { text: names.filter(Boolean).slice(0, 40).join(", ") } : {}),
        }
      : null,
  );
}
