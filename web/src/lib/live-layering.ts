// Where the Live box sits in the stack — a constant with a test, because the
// number is the whole behaviour.
//
// reported 2026-08-03: "we need to deal with the live box - it's on top of so much
// stuff that it shouldn't be. why don't we only have it on top of the base
// pages, and not on top of any modals or other things that go on top of the
// base page? it def does not belong anywhere in the camera scanner."
//
// It used to sit at z-900 and rely on every overlay raising `data-overlay-open`
// so it could hide. That is opt-in, so it only worked for the overlays that
// remembered — the camera scanner didn't, and the pill floated over the
// viewfinder. Sitting BELOW the overlay floor makes it true by construction:
// anything that covers the page covers the Live box, whether or not it thought
// to say so.

/** The lowest overlay in the app: a Modal is z-50, the scanner z-40. */
export const OVERLAY_FLOOR = 40;
/** Page chrome tops out at z-30 (the app header), so the Live box must clear
 *  that to float above the page it belongs to. */
export const PAGE_CHROME_CEILING = 30;

/** The Live box's z-index: above the page, below everything that covers it. */
export const LIVE_Z_VALUE = 35;
/** The Tailwind class. Keep in step with LIVE_Z_VALUE — the test asserts it. */
export const LIVE_Z = "z-[35]";
