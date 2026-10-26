// Every key the app answers to, in one list: what you press, what it does and
// where it works. The shortcut sheet (`?`) and the command palette read it to
// show them; a handler for a named shortcut asks `isShortcut(e, id)` rather
// than spelling its own key; and lint:keys-are-listed fails any keydown
// handler that compares a key this list does not bind, so the sheet cannot
// fall behind what is actually bound.
//
// Only ⌘K was discoverable before (#4227): Escape, the arrows in the photo
// viewer and the tour, ⌘Enter to run, Tab to take the chat's suggestion were
// all real and written nowhere a person could find them.

/** The part of a keyboard event a shortcut reads. */
export interface KeyLike {
  key: string;
  code?: string;
  metaKey?: boolean;
  ctrlKey?: boolean;
  shiftKey?: boolean;
  altKey?: boolean;
}

export interface Shortcut {
  id: string;
  /** What the sheet shows, one cap each. "Mod" is ⌘ on a Mac, Ctrl elsewhere. */
  keys: string[];
  /** What it does, in a person's words. */
  does: string;
  /** Where it works. */
  where: string;
  /** Every KeyboardEvent.key (or .code) a handler for it compares. */
  binds: string[];
  /** Is this event the shortcut? Absent: any of `binds` with no Cmd/Ctrl/Alt. */
  match?: (e: KeyLike) => boolean;
}

const withMod = (e: KeyLike) => !!(e.metaKey || e.ctrlKey);
const bare = (e: KeyLike) => !e.metaKey && !e.ctrlKey && !e.altKey;

export const SHORTCUTS: readonly Shortcut[] = [
  {
    id: "palette",
    keys: ["Mod", "K"],
    does: "Open the command palette: go anywhere, add anything, run anything",
    where: "Everywhere",
    binds: ["k", "K"],
    match: (e) => withMod(e) && e.key.toLowerCase() === "k",
  },
  {
    id: "shortcuts",
    keys: ["?"],
    does: "Show this list",
    where: "Everywhere, outside a box you are typing in",
    binds: ["?"],
    match: (e) => e.key === "?" && !e.metaKey && !e.ctrlKey && !e.altKey,
  },
  {
    id: "close",
    keys: ["Esc"],
    does: "Close what is open on top: a dialog, a sheet, a menu, a photo, the tour",
    where: "Everywhere",
    binds: ["Escape"],
  },
  {
    id: "choose",
    keys: ["Enter"],
    does: "Open the highlighted row, press the focused button, or send what you typed",
    where: "Everywhere; in the chat box, Shift+Enter starts a new line instead",
    binds: ["Enter"],
    match: (e) => e.key === "Enter" && bare(e),
  },
  {
    id: "run",
    keys: ["Mod", "Enter"],
    does: "Answer and run, without leaving a long answer box",
    where: "When an action asks you something before it runs",
    binds: ["Enter"],
    match: (e) => e.key === "Enter" && withMod(e),
  },
  {
    id: "press",
    keys: ["Space"],
    does: "Press the focused card or button; during a live sort, confirm the next step",
    where: "Everywhere",
    binds: [" ", "Space"],
    match: (e) => (e.key === " " || e.code === "Space") && bare(e),
  },
  {
    id: "up-down",
    keys: ["↑", "↓"],
    does: "Move up and down a list; in the chat box, bring back what you sent before",
    where: "The command palette, pickers, menus and the chat box",
    binds: ["ArrowUp", "ArrowDown"],
  },
  {
    id: "first-last",
    keys: ["Home", "End"],
    does: "The first choice, or the last",
    where: "An open menu",
    binds: ["Home", "End"],
  },
  {
    id: "previous",
    keys: ["←"],
    does: "The previous photo, or the previous step of the tour",
    where: "The photo viewer and the guided tour",
    binds: ["ArrowLeft"],
  },
  {
    id: "next",
    keys: ["→"],
    does: "The next photo, or the next step of the tour",
    where: "The photo viewer and the guided tour",
    binds: ["ArrowRight"],
  },
  {
    id: "another-choice",
    keys: [","],
    does: "Keep what you typed as one choice and start the next",
    where: "A box that takes a list of choices, such as a dropdown field's",
    binds: [","],
  },
  {
    id: "drop-choice",
    keys: ["Backspace"],
    does: "Take off the last choice, when nothing is typed",
    where: "A box that takes a list of choices, such as a dropdown field's",
    binds: ["Backspace"],
  },
  {
    id: "turn",
    keys: ["R"],
    does: "Turn the rack you are dragging a quarter, staying inside the room",
    where: "A floor plan in Edit layout, and Plan a layout, while you drag a rack",
    binds: ["r", "R"],
  },
  {
    id: "tab",
    keys: ["Tab"],
    does: "The next control, Shift+Tab the one before; in the chat box, take the suggested wording",
    where: "Everywhere; inside a dialog or an open menu it stays inside it",
    binds: ["Tab"],
  },
];

const BY_ID = new Map(SHORTCUTS.map((s) => [s.id, s]));

/** Is `e` the shortcut `id`? */
export function isShortcut(e: KeyLike, id: string): boolean {
  const s = BY_ID.get(id);
  if (!s) throw new Error(`No shortcut "${id}" in SHORTCUTS`);
  return s.match ? s.match(e) : bare(e) && (s.binds.includes(e.key) || (!!e.code && s.binds.includes(e.code)));
}

/** A cap as this device writes it: "Mod" is ⌘ on a Mac and Ctrl elsewhere. */
export function keyCap(k: string, mac = isMac()): string {
  return k === "Mod" ? (mac ? "⌘" : "Ctrl") : k;
}

function isMac(): boolean {
  if (typeof navigator === "undefined") return false;
  const nav = navigator as Navigator & { userAgentData?: { platform?: string } };
  return /mac|iphone|ipad/i.test(nav.userAgentData?.platform ?? nav.platform ?? "");
}

/** A keydown that lands in a box being typed in: a letter there is text, not a shortcut. */
export function typingIn(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName);
}

/** Anything (the palette, a help link) can open the shortcut sheet. */
export const OPEN_SHORTCUTS_EVENT = "cobblr:open-shortcuts";
