// Page context for Ask Cobb. The screen the user is looking at publishes a short
// summary of itself; the chat widget reads it at send-time and passes it to the
// chat endpoint, which injects it into Cobb's system prompt for situational
// relevance ("you're on the Scan Inbox — 19 pending, 16 waiting 2d+"). Lives in
// platform-web so BOTH core pages and module UIs can publish. Read at send-time
// (no React re-render plumbing): a page just publishes while mounted.

import { useEffect, useRef, useState } from "react";
import { countOf } from "@cobblr/platform-contract/plural";

export interface ChatPageContext {
  /** Human page name, e.g. "Scan Inbox". */
  label: string;
  /** One-line state of what's on screen, e.g. "19 pending, 16 waiting 2d+". */
  summary?: string;
  /** The records this page LISTS, as a kind id ("spices:item"). Set it on a
   *  page that is one list of one kind, and leave it off anywhere else: it is
   *  what lets "move the tea from this page" mean this page. Without it a
   *  plan has to search every list and say so. */
  kind?: string;
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
  // THE WHOLE OBJECT IS KEPT. This used to rebuild it field by field from
  // `label` and `summary`, so `kind` - added later and wired at both the
  // publishing and the reading end - was dropped in the middle. Nothing
  // failed: "move the tea from this page" simply went on meaning the whole
  // workspace, and the unit tests passed because they called the planner
  // directly and never crossed this seam (2026-09-10). A rebuild is a field
  // to forget; a copy is not.
  //
  // The dep is the serialised context: pages build a fresh object every
  // render, so an identity dep would republish forever, and a field list
  // would be the same trap again.
  const key = ctx?.label ? JSON.stringify(ctx) : "";
  useEffect(() => {
    const mine: ChatPageContext | null = key ? (JSON.parse(key) as ChatPageContext) : null;
    current = mine;
    return () => {
      if (current === mine) current = null;
    };
  }, [key]);
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
/** Ticked rows handed to Cobb from a selection bar: × on the bar drops them
 *  from the chat too, so the two never disagree (#4531). */
let rowsFromBar = false;
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
  if (rowsFromBar) {
    bar = null;
    saveBar();
  }
  rowsFromBar = false;
  announce();
}

/** What a bar hands over, with what it needs to say it again for fewer rows. */
interface BarSelection {
  sel: ChatSelection;
  noun?: string;
  names?: Record<string, string>;
}
let bar: BarSelection | null = null;

// The rows a bar handed to Cobb come back with a reload of the same page and
// filters, the way the ticks do (ticked-rows.ts, #4587); a new tab starts
// empty. Kept per tab, beside the ticks.
const BAR_KEY = "cobblr.bar-selection";
function here(): string {
  return typeof location === "undefined" ? "" : location.pathname + location.search;
}
function saveBar(): void {
  try {
    if (bar) sessionStorage.setItem(BAR_KEY, JSON.stringify({ at: here(), ...bar }));
    else sessionStorage.removeItem(BAR_KEY);
  } catch {
    /* no storage: the chip just does not outlive the page */
  }
}
try {
  const saved = typeof sessionStorage === "undefined" ? null : sessionStorage.getItem(BAR_KEY);
  const parsed = saved ? (JSON.parse(saved) as BarSelection & { at?: string }) : null;
  if (parsed?.sel?.label && parsed.at === here()) {
    bar = { sel: parsed.sel, noun: parsed.noun, names: parsed.names };
    rows = parsed.sel;
    rowsFromBar = true;
  }
} catch {
  /* a damaged entry is no selection */
}

export function publishBarSelection(sel: ChatSelection, say?: { noun: string; names: Record<string, string> }): void {
  rows = sel;
  rowsFromBar = true;
  bar = { sel, ...say };
  saveBar();
  announce();
}
/** The selection bar was cleared: its rows leave the chat as well. Rows put
 *  in the chat some other way are not the bar's to take. */
export function clearBarSelection(): void {
  if (!rowsFromBar) return;
  rows = null;
  rowsFromBar = false;
  bar = null;
  saveBar();
  announce();
}
/** Rows the bar handed over that the page no longer shows leave the chip,
 *  which then says the count that is left. */
export function trimBarSelection(shown: ReadonlySet<string>): void {
  if (!rowsFromBar || !bar || !rows?.ids) return;
  const ids = rows.ids.filter((id) => shown.has(id));
  if (ids.length === rows.ids.length) return;
  if (ids.length === 0) return clearBarSelection();
  const names = ids.map((id) => bar?.names?.[id] ?? "").filter(Boolean);
  const noun = bar.noun ?? "item";
  publishBarSelection(
    {
      label: ids.length === 1 ? names[0] || `1 ${noun}` : countOf(ids.length, noun),
      kind: rows.kind,
      ids,
      ...(names.length ? { text: names.slice(0, 40).join(", ") } : {}),
    },
    { noun, names: Object.fromEntries(ids.flatMap((id) => (bar?.names?.[id] ? [[id, bar.names[id]!]] : []))) },
  );
}

/** The captured highlight. Separate slot so it cannot clobber ticked rows. */
export function publishTextSelection(sel: ChatSelection | null): void {
  text = sel;
  announce();
}

/** Forget both — after the message that used them is sent, or on dismiss. */
export function clearChatSelection(): void {
  if (rowsFromBar) {
    bar = null;
    saveBar();
  }
  rows = null;
  rowsFromBar = false;
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

/** What is ticked IS what Cobb is talking about, while it is ticked.
 *
 *  This used to wait for the list's own Ask Cobb button: a checkbox was "do
 *  this to these" and only the button was "let us talk about this". That cost
 *  more than it saved. On the inbox, filtered to one session's eleven items
 *  with all eleven ticked, the owner asked Cobb to "file these in Mugs" and
 *  was asked "which ones?" (2026-10-02): "I shouldn't have to add them to
 *  Cobb just for Cobb to know the context." So the ticks ride every turn as
 *  the "About:" chip, which the person drops with its ×, and "these" means
 *  them (the prompt's selection line). Unticking them all, or a row leaving
 *  the page, takes them out of the chip too (useTickedRows, trimBarSelection),
 *  and leaving the page takes the rest.
 *
 *  The wording stays here so it is the same on every screen ("12 parts",
 *  never "12 selected" on one and "parts: 12" on the next), and the KIND is
 *  the part a page must get right: it is what turns a chip into something
 *  Cobb can act on. Returns the callback the list's Ask Cobb button runs (it
 *  opens Cobb on the selection), or null when nothing is ticked.
 *
 *  With nothing ticked, a list narrowed to some of its rows (one session, a
 *  search, a filter) hands Cobb the rows it shows, as "11 inbox items shown":
 *  on the inbox filtered to one session's eleven, none ticked, "create Mugs
 *  and file these 11 in it" had no "these" to read (2026-10-02). A page
 *  showing everything passes no `shown`, so the whole list is never a chip. */
/** The most rows a narrowed list hands Cobb unticked: the request's own cap. */
const SHOWN_LIMIT = 200;

export function useAskCobbAboutSelection(
  selected: ReadonlySet<string>,
  rows: ReadonlyArray<{ id: string; name?: string | null; title?: string | null }>,
  kind: string,
  /** What one of them is called, in a person's words: "part", "asset". */
  noun: string,
  /** The rows on screen when the list is narrowed to them; null otherwise. */
  shown?: ReadonlyArray<{ id: string; name?: string | null; title?: string | null }> | null,
): (() => void) | null {
  const ticked = [...selected];
  const onScreen = !ticked.length && shown && shown.length > 0 && shown.length <= SHOWN_LIMIT ? shown : null;
  const ids = onScreen ? onScreen.map((r) => r.id) : ticked;
  const named = (onScreen ?? rows.filter((r) => selected.has(r.id))).map((r) => [r.id, r.title ?? r.name ?? ""] as const);
  const names = named.map(([, n]) => n);
  const hand = (): void =>
    publishBarSelection(
      {
        label: onScreen ? `${countOf(ids.length, noun)} shown` : ids.length === 1 ? (names[0] || `1 ${noun}`) : countOf(ids.length, noun),
        kind,
        ids,
        ...(names.some(Boolean) ? { text: names.filter(Boolean).slice(0, 40).join(", ") } : {}),
      },
      { noun, names: Object.fromEntries(named.filter(([, n]) => n)) },
    );
  // The ticks are the context as they change: no press needed. Keyed on the
  // ids and their names, so a name that loads after the tick still reaches
  // the chip. A list whose ticks are plain state (not useTickedRows) is
  // cleared here when they go, and leaving the page clears what it handed.
  const key = `${onScreen ? "shown" : "ticked"}|${kind}|${ids.join(",")}|${names.join("\u0000")}`;
  const handRef = useRef(hand);
  handRef.current = hand;
  useEffect(() => {
    if (ids.length) handRef.current();
    else clearBarSelection();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  useEffect(() => () => clearBarSelection(), []);
  if (ticked.length === 0) return null;
  return () => {
    hand();
    window.dispatchEvent(new CustomEvent("cobblr:open-chat", { detail: {} }));
  };
}
