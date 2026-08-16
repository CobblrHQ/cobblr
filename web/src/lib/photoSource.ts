// A picture taken NOW and a picture chosen off the device are not the same claim.
//
// A capture is a photo of the object in front of you, so it is evidence about
// that object: it may name an unnamed item, and it may be checked against the
// name of a named one. A file off the camera roll is not necessarily a photo of
// anything — it is routinely a marketplace screenshot kept for the dimensions
// on it, a spec sheet, or a receipt. Asking the cross-check "does this picture
// show the named product?" of a web page honestly answers no, and the item
// collects a "this looks wrong" correction offer earned by nothing.
//
// So the SOURCE decides how far a picture is allowed to reach. Pure, because
// this is the rule that keeps an attachment from being mistaken for testimony.

export type PhotoSource = "capture" | "upload";

export interface PhotoReach {
  /** May it be judged against, or supply, the item's identity? */
  drivesIdentity: boolean;
  /** May it become the item's display image without being asked for? */
  becomesDisplay: boolean;
}

export function photoReach(source: PhotoSource): PhotoReach {
  return source === "capture"
    ? { drivesIdentity: true, becomesDisplay: true }
    : // Attached and nothing more. Both promotions stay available to the user
      // explicitly — make-primary for the display image, the card's re-identify
      // action when the upload really is a photo of the thing.
      { drivesIdentity: false, becomesDisplay: false };
}
