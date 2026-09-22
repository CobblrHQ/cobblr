// Is this gallery file the record's cover?
//
// The record stores the cover as an image PATH (whatever the "cover" button
// wrote, `…/files/<id>/raw`, or an older bare id, or a URL somebody pasted),
// and the gallery knows its files by id. For four months the tile compared
// the path's END with the id, which the path the button itself writes never
// matches (it ends in `/raw`), so a cover set from the gallery never earned
// its badge and went on offering "cover". The rule lives here so the tile and
// a test read the same one.
export function isCoverFile(coverImagePath: string | null | undefined, fileId: string): boolean {
  if (!coverImagePath || !fileId) return false;
  if (coverImagePath === fileId || coverImagePath.endsWith(`/${fileId}`)) return true;
  return coverImagePath.includes(`/files/${fileId}/`) || coverImagePath.endsWith(`/files/${fileId}`);
}
