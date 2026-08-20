// Up/Down recall in a chat box — the shell's bargain, which is also Claude
// Code's: the last thing you sent is one keystroke away, and the draft you had
// typed is not the price of looking.
//
// Pure functions, no DOM, because the fiddly parts are all decisions and the
// decisions are what break: which line the caret is on (a textarea holds more
// than one, and Up inside a paragraph must still move the caret), what happens
// when you walk off the end of history (your draft comes back, not an empty
// box), and whether sending the same thing twice buries the entry before it.

/** How many sent messages to remember per workspace. */
export const HISTORY_MAX = 100;

export interface HistoryState {
  /** Oldest first; the last entry is the most recent thing sent. */
  entries: string[];
  /** How far back we are: null = in the live draft, 0 = the newest entry. */
  index: number | null;
  /** What was in the box when browsing started, restored on the way back. */
  draft: string;
}

export function emptyHistory(): HistoryState {
  return { entries: [], index: null, draft: "" };
}

/** Remember something the user sent. Newest last. */
export function remember(entries: string[], text: string, max = HISTORY_MAX): string[] {
  const value = text.trim();
  if (!value) return entries;
  // Only an immediately-preceding duplicate is dropped. Sending the same thing
  // twice an hour apart is two real events, and collapsing them would reorder
  // history under the user.
  const next = entries[entries.length - 1] === value ? entries : [...entries, value];
  return next.length > max ? next.slice(next.length - max) : next;
}

/** One step further back, or null when there is nowhere to go. */
export function recallOlder(state: HistoryState, current: string): { value: string; state: HistoryState } | null {
  const { entries, index } = state;
  if (entries.length === 0) return null;
  const nextIndex = index === null ? 0 : index + 1;
  if (nextIndex >= entries.length) return null; // already at the oldest — stay put
  const value = entries[entries.length - 1 - nextIndex]!;
  return {
    value,
    // The draft is captured on the FIRST step back only; stepping again must not
    // overwrite it with the history entry now sitting in the box.
    state: { entries, index: nextIndex, draft: index === null ? current : state.draft },
  };
}

/** One step back toward the present. Walking off the newest entry restores the
 *  draft rather than clearing the box. */
export function recallNewer(state: HistoryState): { value: string; state: HistoryState } | null {
  const { entries, index, draft } = state;
  if (index === null) return null; // not browsing — Down is the caret's own
  if (index === 0) return { value: draft, state: { entries, index: null, draft } };
  const nextIndex = index - 1;
  return { value: entries[entries.length - 1 - nextIndex]!, state: { entries, index: nextIndex, draft } };
}

/** Back to the live draft — after sending, or as soon as the user types. */
export function stopBrowsing(state: HistoryState): HistoryState {
  return state.index === null ? state : { ...state, index: null, draft: "" };
}

/** Is the caret on the first line? Up only takes over the key when it is;
 *  inside a multi-line message Up belongs to the caret. */
export function caretOnFirstLine(value: string, caret: number): boolean {
  return !value.slice(0, caret).includes("\n");
}

/** Is the caret on the last line? The mirror, for Down. */
export function caretOnLastLine(value: string, caret: number): boolean {
  return !value.slice(caret).includes("\n");
}

/** Per-workspace storage key. Separate from the conversation cache on purpose:
 *  clearing the chat clears what was SAID, and should not also forget what you
 *  typed, the same way a shell's history outlives `clear`. */
export function historyStoreKey(slug: string | null | undefined): string | null {
  return slug ? `cobblr.cobbinput.${slug}` : null;
}

export function loadHistory(slug: string | null | undefined): string[] {
  const key = historyStoreKey(slug);
  if (!key) return [];
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(key) ?? "[]");
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === "string") : [];
  } catch {
    return [];
  }
}

export function saveHistory(slug: string | null | undefined, entries: string[]): void {
  const key = historyStoreKey(slug);
  if (!key) return;
  try {
    if (entries.length) localStorage.setItem(key, JSON.stringify(entries));
    else localStorage.removeItem(key);
  } catch {
    /* quota exceeded / storage disabled — recall just won't survive a refresh */
  }
}
