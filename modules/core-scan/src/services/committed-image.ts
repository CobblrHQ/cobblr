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
