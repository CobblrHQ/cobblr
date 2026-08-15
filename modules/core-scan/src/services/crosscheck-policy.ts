/** What the barcode-vs-photo cross-check is allowed to conclude, and from what.
 *
 *  The check runs one of two ways. When the observe pass has already described
 *  the photo, "does this photo show <name>?" is answered as a TEXT comparison
 *  against that description, which is cheap and needs no image upload. Otherwise
 *  a vision call reads the pixels.
 *
 *  Those two are not interchangeable, and treating them as though they were
 *  cost a user a correct identity (reported 2026-08-14). A barcode resolved to
 *  "cumin" via Open Food Facts, correctly; the observe pass had misread a dark
 *  photo of the jar; the text check compared the name against that prose,
 *  answered "no", and renamed the item to "Ground Cloves" with a reason citing
 *  a label icon it had never seen. It then voted that identity into the shared
 *  barcode database, where a wrong answer stops being one workspace's problem.
 *
 *  WHY THE OBVIOUS GUARD DOES NOT WORK. The instinct is to rank the sources:
 *  let a photo correct a flimsy barcode but not a curated one. Measured against
 *  the two cases that matter, that rule cannot tell them apart. The yarn skein
 *  whose code resolves to an "Anchorman Action Figure" (198973386273, go-upc)
 *  and the cumin (099482444792, Open Food Facts) are BOTH full-length codes
 *  from curated providers. Ranking by the stored name's pedigree would have
 *  protected the cumin by breaking the yarn correction, which is a documented,
 *  deliberate feature (see barcode-negative-votes.md).
 *
 *  What separates them is not the name being challenged. It is the evidence
 *  doing the challenging: the cumin verdict came from prose about a photo, the
 *  yarn verdict survives looking at one. So the rule is about BASIS, not
 *  pedigree:
 *
 *    A description-derived mismatch is a SUSPICION. Only an image-derived
 *    mismatch is a FINDING, and only a finding may rename, flag or vote.
 *
 *  A cheap text "no" therefore escalates to the pixels rather than acting, and
 *  the expensive call is paid only on the rare occasions the cheap one objects.
 *  Both motivating cases come out right: the escalated look sees a cumin jar
 *  and clears it, and sees yarn and corrects it. */

export type CheckBasis = "image" | "text";

/** Which pass to run first. Text when the photo is already described. */
export function firstPass(hasObservation: boolean): CheckBasis {
  return hasObservation ? "text" : "image";
}

/** A mismatch claimed from a description must be confirmed against the photo
 *  before anything is done about it. Anything other than a mismatch is taken at
 *  face value: a text "yes" merely leaves the barcode's own answer standing,
 *  which is where the row already was. */
export function needsEscalation(basis: CheckBasis, matchVerdict: string): boolean {
  return basis === "text" && matchVerdict.toLowerCase() === "no";
}

/** May a `match:"no"` on this basis rename the row, flag it, or vote outward? */
export function mayActOnMismatch(basis: CheckBasis): boolean {
  return basis === "image";
}

/** May the row claim "Matches your photo"?
 *
 *  Only when a model actually compared the photo. The note used to appear on
 *  any positive verdict including the text one, so it sat beside catalog art
 *  that nothing had compared to anything (reported 2026-08-14). A text "yes"
 *  now leaves the barcode's own provenance note alone rather than dressing it
 *  up as photo confirmation. */
export function earnsMatchesYourPhoto(basis: CheckBasis, matchVerdict: string): boolean {
  return basis === "image" && matchVerdict.toLowerCase() === "yes";
}

/** What a photo somebody deliberately ADDED to an item should be used for.
 *
 *  The gesture carries two intents and cannot distinguish them: "the name is
 *  right, this picture is better" and "the name is wrong, here is proof" press
 *  the same button (reported 2026-08-14). Rather than making people declare
 *  which, the picture always becomes the display image and the identification
 *  work is chosen from what the item already has:
 *
 *    NO NAME     nothing to protect, and this photo is the only evidence there
 *                is. Identify from it outright.
 *    HAS A NAME  the disagreement is OFFERED, not performed. Being asked to tap
 *                once to accept a correction costs a second; having an item you
 *                were happy with renamed underneath you is the complaint that
 *                opened this whole list. */
export function addedPhotoIntent(hasName: boolean): "identify" | "offer-correction" {
  return hasName ? "offer-correction" : "identify";
}
