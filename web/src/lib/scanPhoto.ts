// Which photo leads, answered ONCE.
//
// A scan item can carry three pictures: the catalog art the lookup found, the
// user's own scan photo, and the not-yet-uploaded local frame. Which one leads
// is not a free choice, and the rule has two halves:
//
// - While the check is merely PENDING, the catalog art leads anyway, marked
//   "checking". Holding it back until the check cleared made the main image
//   lag the strip by seconds, and ruled on it (2026-08-05): "if the image
//   is good enough to put in the strip, it's good enough to put into the main
//   image." Optimistic display, honest label.
// - A CONFIRMED mismatch demotes it: a collided or spam UPC resolves to junk
//   (an action figure over a yarn skein), and leading with wrong art reads as
//   "the scanner failed". The user's own photo steps back in.
//
// That rule was implemented independently on SEVEN surfaces (result sheet main
// image, its photo strip, the inbox row, the expanded row, the grid tile, two
// capture-drawer ladders, and two panels), and only two of them knew about the
// cross-check. So the strip announced the catalog shot as the "Display photo"
// while the main image two inches above it deliberately showed the user's own
// (reported 2026-08-04). Two surfaces answering the same question separately always
// drift — the same lesson as useScanQuantity/QtyStepper.
//
// So: the DECISION lives here. URL construction stays with the caller, because
// each surface legitimately wants a different variant (thumb vs med) and has
// its own broken-src handling.

export type PhotoRole = "catalog" | "yours" | "frame";

export interface ScanPhotoItem {
  catalog_image_file_id?: string | null;
  catalog_image_url?: string | null;
  image_file_id?: string | null;
  suggested_metadata?: unknown;
}

/** Is the catalog art still unverified against the user's photo? Drives the
 *  "checking" labels — NOT the ordering (see photoOrder). */
export function photoUnverified(item: ScanPhotoItem | null | undefined): boolean {
  const meta = (item?.suggested_metadata ?? {}) as {
    photo_check_pending?: boolean;
    photo_mismatch?: unknown;
  };
  return meta.photo_check_pending === true || !!meta.photo_mismatch;
}

/** Did the cross-check conclude the catalog art is WRONG? The only state that
 *  demotes it. */
export function photoMismatched(item: ScanPhotoItem | null | undefined): boolean {
  return !!(item?.suggested_metadata as { photo_mismatch?: unknown } | null)?.photo_mismatch;
}

/** Preference order for THIS item, most-preferred first. Only a CONFIRMED
 *  mismatch demotes the catalog art; a pending check shows it optimistically
 *  (with `pending` telling the caller to label it "checking"). */
export function photoOrder(item: ScanPhotoItem | null | undefined): PhotoRole[] {
  return photoMismatched(item)
    ? ["yours", "frame", "catalog"]
    : ["catalog", "yours", "frame"];
}

/** Did a person choose this item's catalog picture on the card (a web pick,
 *  the AI's pick they pressed for, their own photo, an upload, a crop)? The
 *  route stamps it on every one of those; a lookup's own find never sets it. */
export function catalogChosen(item: ScanPhotoItem | null | undefined): boolean {
  return !!(item?.suggested_metadata as { catalog_image_user_set?: boolean } | null)?.catalog_image_user_set;
}

/** The picture already on the record this item was matched to, when there is
 *  one. An entity image_path is already what useImageSrc takes. */
export function trackedPicture(item: ScanPhotoItem | null | undefined): string | null {
  const m = (item?.suggested_metadata as { tracked_match?: { image_path?: string | null } | null } | null)
    ?.tracked_match;
  return m?.image_path || null;
}

/**
 * The catalog rungs for THIS item, most-preferred first, with the tracked
 * record's picture placed by ONE rule:
 *
 * - The picture a person CHOSE on this card comes first. They picked it
 *   looking at this very item, match banner and all; a card that keeps
 *   showing the record's old picture after "Catalog photo updated" is lying
 *   (reported 2026-09-12: "except it's not updating!").
 * - Otherwise the record's own picture comes first. A re-purchase off a
 *   receipt searched the web again and came home with a tin of cherry
 *   tomatoes over a photo the owner had picked by hand for that record
 *   (2026-09-06). A lookup's find never outranks what is already chosen for
 *   the thing you have.
 *
 * `own` is the item's catalog slot as the caller builds it (a stored file,
 * then the external URL). The tracked rule used to live inline on the
 * expanded card only, so the gallery tile never knew the record had a picture
 * and the card never knew the person had picked one.
 */
export function catalogRungs(
  item: ScanPhotoItem | null | undefined,
  own: Array<string | null | undefined>,
): Array<string | null | undefined> {
  const tracked = trackedPicture(item);
  if (!tracked) return own;
  return catalogChosen(item) ? [...own, tracked] : [tracked, ...own];
}

export interface PhotoSources {
  /** The item's OWN catalog rungs in order (a stored file, then the external
   *  URL). The tracked record's picture is placed by catalogRungs, not here. */
  catalog?: Array<string | null | undefined>;
  yours?: string | null;
  frame?: string | null;
}

export interface LeadPhoto {
  /** The URL to render, or null when the item has no usable picture. */
  src: string | null;
  /** Which picture won — what the UI should CALL it. */
  role: PhotoRole | null;
  /** True while the catalog art is unverified: the reason a caller shows a
   *  "checking" treatment instead of asserting a display photo. */
  pending: boolean;
}

/**
 * Pick the leading photo. `isBroken` lets a caller skip URLs that already
 * failed to load (external catalog URLs hotlink-block routinely).
 */
export function leadPhoto(
  item: ScanPhotoItem | null | undefined,
  srcs: PhotoSources,
  isBroken: (src: string) => boolean = () => false,
): LeadPhoto {
  const pending = photoUnverified(item);
  const byRole: Record<PhotoRole, Array<string | null | undefined>> = {
    catalog: catalogRungs(item, srcs.catalog ?? []),
    yours: [srcs.yours],
    frame: [srcs.frame],
  };
  for (const role of photoOrder(item)) {
    for (const candidate of byRole[role]) {
      if (candidate && !isBroken(candidate)) return { src: candidate, role, pending };
    }
  }
  return { src: null, role: null, pending };
}
