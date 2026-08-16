// Is THIS device the one you would actually photograph something with?
//
// One button on a scan card means "I'll photograph this", and the only thing
// that varies is whether that happens now or later. The device answers it, so
// nothing has to be configured and the button means one thing everywhere.
//
// NOT "does a camera exist". A laptop has a webcam and nobody photographs a
// part on a shelf with it — answering yes there would open a useless viewfinder
// instead of doing the useful thing, which is to carry the item to the phone.
// A coarse pointer AND a narrow viewport is the honest test for "this is the
// thing in my hand".
//
// Pure, so the rule is testable without a browser: the caller passes what it
// measured.

/** Width at or below which a device is being held rather than sat at. Matches
 *  Tailwind's `md` breakpoint, which is where the app's own layout already
 *  decides the same thing. */
export const HANDHELD_MAX_PX = 768;

export interface DeviceShape {
  /** `matchMedia("(pointer: coarse)")` — a finger, not a mouse. */
  coarsePointer: boolean;
  /** Viewport width in CSS pixels. */
  width: number;
}

/**
 * True when pressing the photo button should open the camera; false when it
 * should mark the item for later.
 *
 * Both conditions are required, and each rules out a real device:
 *  - coarse pointer alone: a touchscreen desktop monitor, still not a camera
 *    you would carry to a shelf.
 *  - narrow viewport alone: a shrunk browser window on the desktop, which is
 *    the case that would otherwise fire every time someone tiles two windows.
 */
export function canPhotographHere(d: DeviceShape): boolean {
  return d.coarsePointer && d.width <= HANDHELD_MAX_PX;
}

/** What the button should DO, as a word the UI can switch on. */
export type PhotoPress = "capture" | "mark";

export function photoPressAction(d: DeviceShape, alreadyWanted: boolean): PhotoPress | "clear" {
  if (alreadyWanted) return "clear"; // a second press always undoes, on any device
  return canPhotographHere(d) ? "capture" : "mark";
}

/** Read the current device from the browser. Kept separate from the rule above
 *  so the rule stays testable. */
export function measureDevice(): DeviceShape {
  const coarse =
    typeof window !== "undefined" && typeof window.matchMedia === "function"
      ? window.matchMedia("(pointer: coarse)").matches
      : false;
  return { coarsePointer: coarse, width: typeof window !== "undefined" ? window.innerWidth : 1280 };
}
