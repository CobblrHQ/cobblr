// The row's pictures with their addresses on THIS api: the contract's
// resolver (scan-pictures) knows files and roles; this turns a file into a
// URL at the variant a surface wants. The one place in web/src that builds a
// picture URL from a row's own files (lint:row-pictures-resolved).
import {
  currentPicture,
  leadYours,
  rowPictures as resolve,
  yourPictures,
  type PicturesContext,
  type PictureRow,
  type RowPicture,
} from "@cobblr/platform-contract/scan-pictures";

export type { RowPicture, PictureRole } from "@cobblr/platform-contract/scan-pictures";
export { yourPictures, leadYours, currentPicture };

export type PictureVariant = "thumb" | "med";

export interface PictureUrls {
  /** The address to render: the stored file at the variant, else the
   *  picture's own address (a web tile, a catalog picture not stored yet). */
  src: (p: RowPicture, variant?: PictureVariant) => string | null;
}

/** A file's address on this workspace's file store. */
export function scanFileUrl(slug: string, fileId: string, variant: PictureVariant = "med"): string {
  return `/api/v1/orgs/${slug}/modules/core-files/files/${fileId}/raw?variant=${variant}`;
}

/** The row's pictures, resolved once, with `src` for each. */
export function rowPictures(slug: string, row: PictureRow, ctx: PicturesContext = {}): { pictures: RowPicture[] } & PictureUrls {
  const pictures = resolve(row, ctx);
  return {
    pictures,
    src: (p, variant = "med") => (p.fileId ? scanFileUrl(slug, p.fileId, variant) : p.role === "web" && variant === "thumb" && p.thumbUrl ? p.thumbUrl : p.url),
  };
}
