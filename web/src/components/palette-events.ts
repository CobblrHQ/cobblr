import { isShortcut } from "@cobblr/platform-web/shortcuts";

// The palette's and the quick-add sheet's openers, apart from the components
// themselves: the shell's buttons fire these at first paint, and the palette
// loads after it (#5971).

/** Anything (the mobile bar, the palette) can ask for the quick-add sheet. */
export const OPEN_ADD_SHEET_EVENT = "cobblr:open-add-sheet";
/** Programmatic opener (the full-sidebar foot's search button uses it — a
 *  centered palette beats a cramped popover anchored in a 208px column). */
export const OPEN_PALETTE_EVENT = "cobblr:open-palette";

// The palette and the sheet load just after the first paint. A shortcut
// pressed, or an opener fired, in that moment would otherwise reach nothing:
// the shell holds it here until the host that answers it has loaded.
const waiting = new Set<string>();
const ready = new Set<string>();

/** The shell calls this at first paint; the returned function stops it. */
export function holdEarlyOpeners(isPaletteKey: (e: KeyboardEvent) => boolean): () => void {
  const hold = (name: string) => () => {
    if (!ready.has(name)) waiting.add(name);
  };
  const onKey = (e: KeyboardEvent) => {
    if (ready.has(OPEN_PALETTE_EVENT) || !isPaletteKey(e)) return;
    e.preventDefault();
    waiting.add(OPEN_PALETTE_EVENT);
  };
  const stops = [OPEN_PALETTE_EVENT, OPEN_ADD_SHEET_EVENT].map((name) => {
    const f = hold(name);
    window.addEventListener(name, f);
    return () => window.removeEventListener(name, f);
  });
  window.addEventListener("keydown", onKey);
  return () => {
    for (const s of stops) s();
    window.removeEventListener("keydown", onKey);
  };
}

/** A host has loaded and listens for `name` itself from now on. True when
 *  its opener came while it was loading, so it opens at once. */
export function hostLoaded(name: string): boolean {
  ready.add(name);
  return waiting.delete(name);
}

/** The host is gone (the shell unmounted it): openers are held again. */
export function hostGone(name: string): void {
  ready.delete(name);
}

// Held from the moment the shell's script runs, not from the shell's first
// render: an effect started holding only after React had drawn, so a ⌘K
// pressed as the page appeared reached nothing (#5999). Like the chat's
// buffer (lib/open-chat-buffer.ts), this listens at load. The entry
// (main.tsx) imports this file before it waits on the branding read, so the
// hold starts with the first script, not when the shell's chunk arrives: a
// ⌘K pressed while branding loaded reached nothing (#6881).
if (typeof window !== "undefined") holdEarlyOpeners((e) => isShortcut(e, "palette"));
