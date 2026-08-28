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
 *    1. a photo the user actually took wins over anything from a catalog;
 *    2. a colour swatch identity (a yarn's colourway) suppresses a generic
 *       internet photo, which would otherwise hide the swatch they chose;
 *    3. otherwise the catalog image, stored file first, raw URL as the fallback
 *       so the picture is NEVER silently dropped.
 */
export function commitThumbPath(
  orgSlug: string,
  scan: {
    userPhotoFileIds: readonly string[];
    catalogImageFileId: string | null;
    catalogImageUrl: string | null;
    /** The committed colour, if the kind identifies by swatch. */
    colorHex?: string | null;
  },
): string | null {
  const userPhoto = scan.userPhotoFileIds[0];
  if (userPhoto) return committedImagePath(orgSlug, userPhoto, null);
  const hasColorSwatch = /^#[0-9a-fA-F]{3,8}$/.test((scan.colorHex ?? "").trim());
  if (hasColorSwatch) return null;
  return committedImagePath(orgSlug, scan.catalogImageFileId, scan.catalogImageUrl);
}
