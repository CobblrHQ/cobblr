// Where an ARMED shot lands you, and when the barcode detector must stay quiet.
//
// Two decisions the camera page used to make inline, and got wrong in the same
// way: they answered for the moment you ARMED, not the moment the shot LANDED.
//
// The upload behind an armed shot takes seconds. By the time it resolves the
// person has usually scanned the next item. The old rule - "arm came from a
// sheet, so reopen the sheet" - then raised the PREVIOUS item's review sheet
// over the new scan, and while a review sheet is up the detector ignores every
// barcode. The report (2026-08-30): "stuck with a different card when I've
// already hit submit and want to move on to a new item."
//
// Pure, so both rules are testable without a camera.

export type ArmOrigin = "shutter" | "result" | "review";

export interface LandingContext {
  /** Where the arm was made: the + shutter, a barcode RESULT sheet, or a
   *  REVIEW sheet reopened on an existing item. */
  origin: ArmOrigin;
  /** The camera's phase when the shot LANDED, not when it was armed. */
  phase: string;
  /** The review sheet open right now, if any. */
  reviewOpenId: string | null;
  /** The item the shot attached to. */
  targetId: string;
}

export interface Landing {
  /** Reopen the review sheet on the target. */
  reopenReview: boolean;
  /** Show the target in the mini drawer as the "still on this scan" strip. */
  showDrawer: boolean;
}

export function afterArmedShot(c: LandingContext): Landing {
  // Moved on: a newer scan is in flight or on screen. Nothing of the OLD item
  // may surface over it - not a sheet, not the drawer under the next sheet.
  if (c.phase === "result" || c.phase === "resolving") return { reopenReview: false, showDrawer: false };
  // A different review sheet is up: same rule, the person is elsewhere.
  if (c.reviewOpenId && c.reviewOpenId !== c.targetId) return { reopenReview: false, showDrawer: false };
  // You were REVIEWING this item and asked for a photo of it: come back to it.
  if (c.origin === "review") return { reopenReview: true, showDrawer: true };
  // A barcode result sheet, or the + shutter: the photo was the whole errand.
  // The drawer shows it landed; the next barcode is a new item.
  return { reopenReview: false, showDrawer: true };
}

export interface DetectGate {
  armed: boolean;
  /** A photo/retake/discard queued before the row landed. The arm does not
   *  exist yet, but the person is already lining up the shot. */
  earlyIntent: string | null;
  sheetOpen: boolean;
  reviewOpen: boolean;
}

/** True when a decoded barcode must be IGNORED. */
export function ignoresCodes(g: DetectGate): boolean {
  // Armed, or about to be: the camera is a photo camera now, and the label you
  // are framing carries a barcode. Reading it would mint a second item
  // mid-append - the hole the early-intent path opened, because the guard only
  // knew about a finished arm.
  if (g.armed || g.earlyIntent) return true;
  // A sheet is up: the person is editing, not scanning.
  return g.sheetOpen || g.reviewOpen;
}

/** The code an armed shot just finished with, and when. */
export interface HandledCode {
  raw: string;
  at: number;
}

/** How long the code you just dealt with must be OUT of the frame before a
 *  read of it is a scan again. The window slides while the code keeps
 *  arriving, so it measures absence, not time since the shot. */
export const HANDLED_ECHO_MS = 2000;

/**
 * Is this decode an ECHO of the item the armed shot just landed on?
 *
 * After "+" and the shutter, the phone is still pointed at the same label -
 * that is where the person was standing to take the picture. The decoder
 * reads the same barcode again a frame later, and until the review sheet's
 * ref catches up with the render it counts as a fresh scan: a new "Looking
 * up…" result sheet for the code you just handled replaces the review you
 * were sent back to, with the name and both pictures gone. That is "stuck with
 * a different card" (the operator, 2026-08-31), reproduced on a fake camera
 * feed 2026-09-01. A different code is a real next item and goes through.
 */
export function isEchoOfHandled(raw: string, handled: HandledCode | null, now: number): boolean {
  if (!handled) return false;
  return sameCode(raw, handled.raw) && now - handled.at < HANDLED_ECHO_MS;
}

/** The decoder hands over a 12-digit UPC-A; the row stores it as 13-digit
 *  EAN with a leading zero. Same label. A plain string compare called the
 *  echo a new code and let the re-scan through (found on the fake feed). */
function sameCode(a: string, b: string): boolean {
  const x = a.trim(), y = b.trim();
  if (x === y) return true;
  if (/^\d+$/.test(x) && /^\d+$/.test(y)) return x.replace(/^0+/, "") === y.replace(/^0+/, "");
  return false;
}
