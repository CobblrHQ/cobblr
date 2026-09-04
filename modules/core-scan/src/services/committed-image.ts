// Resolve the image_path to stamp on a part when a scan is committed.
//
// Invariant (guards the class of bug where a committed part loses its picture):
// if the scan carries ANY image representation — a stored catalog file OR a raw
// catalog URL — the committed part MUST get an image_path. A stored file wins
// (stable, same-origin); a raw URL is the last-resort fallback so the image is
// never silently dropped (reported 2026-07-24). Only a scan with neither yields null.
export function committedImagePath(
  orgSlug: string,
  catalogImageFileId: string | null,
  catalogImageUrl: string | null,
): string | null {
  if (catalogImageFileId) {
    return `/api/v1/orgs/${orgSlug}/modules/core-files/files/${catalogImageFileId}/raw`;
  }
  if (catalogImageUrl) return catalogImageUrl;
  return null;
}

/** The captures that actually DEPICT the item.
 *
 *  A barcode frame is a picture of a barcode — scaffolding the scanner used to
 *  identify the thing, never a portrait OF the thing — so it is not an item
 *  photo and must never become the item's picture. Dropping it here is what
 *  keeps the "a photo the user took wins" rule from misfiring on every barcode
 *  scan: a shelf of books each showing a snap of its own barcode while the
 *  catalog cover sat right there, already resolved (reported 2026-09-03; the
 *  scan inbox showed the cover, the committed book showed the barcode).
 */
export function itemPhotos(
  userPhotoFileIds: readonly string[],
  barcodeFrameFileIds: readonly string[] = [],
): string[] {
  const frames = new Set(barcodeFrameFileIds.filter(Boolean));
  return userPhotoFileIds.filter((id) => !frames.has(id));
}

/** Which image a COMMIT should stamp, given everything the scan carries.
 *
 *  Extracted from the confirm handler because it was inline there, and inline is
 *  how it drifted: the location path called committedImagePath and honoured the
 *  invariant, while the item path hand-rolled a files/<id>/raw string from the
 *  catalog FILE id alone and silently stamped nothing when the image was still a
 *  URL (2026-08-27). One decision, one place, and the handler no longer builds
 *  image paths at all.
 *
 *  The rules, in order:
 *    1. a photo the user actually took OF THE ITEM wins over anything from a
 *       catalog — but a BARCODE FRAME is not such a photo (see itemPhotos) and
 *       never wins, not even when there is no catalog image to fall back to;
 *    2. a colour swatch identity (a yarn's colourway) suppresses a generic
 *       internet photo, which would otherwise hide the swatch they chose;
 *    3. otherwise the catalog image, stored file first, raw URL as the fallback
 *       so the picture is NEVER silently dropped.
 */
export function commitThumbPath(
  orgSlug: string,
  scan: {
    userPhotoFileIds: readonly string[];
    /** Captures that were BARCODE READS, not pictures of the item. Excluded from
     *  the user-photo preference so a barcode never becomes the thumbnail. */
    barcodeFrameFileIds?: readonly string[];
    catalogImageFileId: string | null;
    catalogImageUrl: string | null;
    /** The committed colour, if the kind identifies by swatch. */
    colorHex?: string | null;
  },
): string | null {
  const userPhoto = itemPhotos(scan.userPhotoFileIds, scan.barcodeFrameFileIds ?? [])[0];
  if (userPhoto) return committedImagePath(orgSlug, userPhoto, null);
  const hasColorSwatch = /^#[0-9a-fA-F]{3,8}$/.test((scan.colorHex ?? "").trim());
  if (hasColorSwatch) return null;
  return committedImagePath(orgSlug, scan.catalogImageFileId, scan.catalogImageUrl);
}
