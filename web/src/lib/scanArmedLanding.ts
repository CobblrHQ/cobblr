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
