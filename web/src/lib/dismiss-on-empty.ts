// "I clicked the empty part and nothing happened."
//
// An overlay that fills the screen has no OUTSIDE to tap, so the usual
// click-the-backdrop-to-dismiss gesture has nowhere to land. The mobile nav is
// `absolute inset-0`: its backdrop sits behind an opaque full-screen panel and
// can never be reached, so the slack below the last destination was simply
// dead. Tapping there did nothing at all, which reads as a stuck menu rather
// than as a deliberate hit area (reported 2026-08-15).
//
// The rule that fixes it is the one every lightbox and sheet wants: a click
// BELONGS to the nearest control, and anything else is empty space and means
// dismiss.

/** What a click can belong to. Everything else is empty space.
 *
 *  `label` is in here because tapping a label activates its input, and
 *  `[role]` variants because a div can be a button in every way that matters to
 *  someone using it. */
export const INTERACTIVE_SELECTOR =
  "a, button, input, select, textarea, label, [role='button'], [role='link'], [role='menuitem'], [role='tab']";

/**
 * A click handler that dismisses when the click landed on nothing.
 *
 * Deliberately not `e.target === e.currentTarget`, which is the other common
 * idiom: that only fires for the container ITSELF, so any wrapper div in
 * between (a padding row, a two-column shell) becomes dead again. Asking what
 * the click belongs to keeps working however the layout is nested.
 */
export function dismissOnEmptySpace(close: () => void) {
  return (e: { target: EventTarget | null }) => {
    const el = e.target as HTMLElement | null;
    if (!el?.closest?.(INTERACTIVE_SELECTOR)) close();
  };
}
