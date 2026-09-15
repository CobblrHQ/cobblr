// The pictures a scan row has, resolved ONCE (#3046).
//
// A row's pictures used to be computed four ways: the pair read
// image_file_id + catalog_image_file_id, the strip's "Your photos" column
// read extra_photos, the phone screen and the lightbox each read their own
// subset, and the outline that says which tile is current was worked out a
// third way (a URL or a file id). So a split child, whose pictures are its
// own crop and the group shot it was cut from, showed an EMPTY "Your photos"
// column on the desk: its crop lived in the pair, the group shot lived on the
// parent, and nothing listed either as a picture of this row.
//
// One resolver, one ordered list, one role per picture, the current one
// marked once. Every surface reads it; nothing else lists a row's pictures
// (lint:row-pictures-resolved). URL construction stays with the caller,
// since each surface wants its own variant (thumb, med) and has its own
// broken-src handling; the contract knows files and addresses, not routes.
//
// Which picture LEADS (the thumbnail) is a different question with its own
// rule (the web's scanPhoto.ts: a confirmed mismatch demotes the catalog
// art). This lists what exists; that chooses among it.

export type PictureRole =
  /** The row's own photo, as taken. */
  | "own"
  /** A cut of a bigger picture: a split child's piece of the group shot, or
   *  the item cut out of a screenshot by the enrich. */
  | "crop"
  /** The group shot a split child was cut from (the parent's photo). */
  | "group"
  /** A photo added to the row after the fact. */
  | "extra"
  /** The catalog picture, when it is not one of the row's own. */
  | "catalog"
  /** A web result the strip fetched. */
  | "web";

export interface RowPicture {
  /** Stable across renders: role and file or address. */
  key: string;
  role: PictureRole;
  /** A stored file, when it is one. */
  fileId: string | null;
  /** An address, for a web tile or a catalog picture not stored yet. */
  url: string | null;
  /** A web tile's smaller copy, when the search gave one. */
  thumbUrl: string | null;
  /** The pane's caption. */
  caption: string;
  /** This picture IS the row's catalog picture right now. At most one. */
  current: boolean;
  /** For a crop: what it was cut from. */
  cropOf?: "group" | "screenshot";
  /** For a web tile: where it came from. */
  source?: string | null;
}

/** The columns and keys the resolver reads. */
export interface PictureRow {
  image_file_id: string | null;
  catalog_image_file_id: string | null;
  catalog_image_url: string | null;
  /** A split child's group shot: the parent's image, served on the child so
   *  no surface fetches the parent to know (#3046). */
  group_image_file_id?: string | null;
  suggested_metadata?: unknown;
}

export interface WebTile {
  url: string;
  thumb?: string | null;
  title?: string | null;
  source?: string | null;
}

export interface PicturesContext {
  /** The web candidates the strip fetched, in its order. */
  web?: readonly WebTile[];
}

/** The roles that are the row's OWN pictures: what "Your photos" shows and
 *  what the pair's yours slot chooses from. */
export const YOUR_ROLES: ReadonlySet<PictureRole> = new Set<PictureRole>(["own", "crop", "group", "extra"]);

export function rowPictures(row: PictureRow, ctx: PicturesContext = {}): RowPicture[] {
  const meta = (row.suggested_metadata ?? {}) as {
    split_from?: unknown;
    extra_photos?: unknown;
    screenshot_crop_file_id?: unknown;
  };
  const out: RowPicture[] = [];
  const seen = new Set<string>();
  const file = (role: PictureRole, id: string, caption: string, extra: Partial<RowPicture> = {}): void => {
    if (seen.has(id)) return;
    seen.add(id);
    out.push({ key: `${role}:${id}`, role, fileId: id, url: null, thumbUrl: null, caption, current: false, ...extra });
  };

  const group = row.group_image_file_id ?? null;
  const isSplitChild = !!meta.split_from;
  if (row.image_file_id) {
    if (isSplitChild && group && row.image_file_id === group) {
      // The crop could not be cut: the child keeps the group shot as its own.
      file("group", row.image_file_id, "The group photo");
    } else if (isSplitChild) {
      file("crop", row.image_file_id, "Your photo, cut from the group", { cropOf: "group" });
    } else {
      file("own", row.image_file_id, "Your photo");
    }
  }
  if (isSplitChild && group) file("group", group, "The group photo");
  if (typeof meta.screenshot_crop_file_id === "string" && meta.screenshot_crop_file_id) {
    file("crop", meta.screenshot_crop_file_id, "From your screenshot", { cropOf: "screenshot" });
  }
  if (Array.isArray(meta.extra_photos)) {
    for (const id of meta.extra_photos) if (typeof id === "string" && id) file("extra", id, "Added photo");
  }

  // The catalog picture, once. It is one of the row's own (a crop, an added
  // photo made primary): that pane is current. It is a web address the strip
  // also shows: that tile is current, stored copy or not, since the tile is
  // the picture and the outline is what says "you picked this one" (#2982).
  // Otherwise it gets a pane of its own, the stored file first.
  const web = ctx.web ?? [];
  const catalogFile = row.catalog_image_file_id ?? null;
  const catalogUrl = row.catalog_image_url ?? null;
  let current: RowPicture | null = catalogFile ? (out.find((p) => p.fileId === catalogFile) ?? null) : null;
  const webTiles: RowPicture[] = web.map((t) => ({
    key: `web:${t.url}`,
    role: "web",
    fileId: null,
    url: t.url,
    thumbUrl: t.thumb ?? null,
    caption: [t.title, t.source].filter(Boolean).join(" · ") || "Web result",
    current: false,
    source: t.source ?? null,
  }));
  if (!current && catalogUrl) current = webTiles.find((t) => t.url === catalogUrl) ?? null;
  if (!current && (catalogFile || catalogUrl)) {
    const pane: RowPicture = catalogFile
      ? { key: `catalog:${catalogFile}`, role: "catalog", fileId: catalogFile, url: catalogUrl, thumbUrl: null, caption: "Catalog image", current: false }
      : { key: `catalog:${catalogUrl}`, role: "catalog", fileId: null, url: catalogUrl, thumbUrl: null, caption: "Catalog image", current: false };
    out.push(pane);
    current = pane;
  }
  out.push(...webTiles);
  if (current) current.current = true;
  return out;
}

/** The row's own pictures, in order: what "Your photos" shows. Empty means
 *  no column, on every surface. */
export function yourPictures(pictures: readonly RowPicture[]): RowPicture[] {
  return pictures.filter((p) => YOUR_ROLES.has(p.role));
}

/** The picture the pair's YOURS slot shows: the row's own photo, or its
 *  crop, or the group shot it kept. */
export function leadYours(pictures: readonly RowPicture[]): RowPicture | null {
  return pictures.find((p) => p.role === "own") ?? pictures.find((p) => p.role === "crop" && p.cropOf === "group") ?? pictures.find((p) => p.role === "group") ?? null;
}

/** The one picture marked current, if any. */
export function currentPicture(pictures: readonly RowPicture[]): RowPicture | null {
  return pictures.find((p) => p.current) ?? null;
}
