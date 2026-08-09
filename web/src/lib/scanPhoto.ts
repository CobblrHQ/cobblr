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

export interface PhotoSources {
  /** Catalog rungs in order (a stored file, then the external URL). */
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
    catalog: srcs.catalog ?? [],
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
