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

/** The row's stored catalog picture is the one its order email printed
 *  beside the line (order_line_image, stored as catalog_image_from). */
export function orderEmailPicture(meta: unknown): boolean {
  const m = (meta ?? {}) as { order_line_image?: unknown; catalog_image_from?: unknown };
  return typeof m.order_line_image === "string" && m.order_line_image !== "" && m.catalog_image_from === m.order_line_image;
}

/** The row's stored catalog picture is its variant's own photo on the
 *  store's page (store_line_image, #5719). */
export function storePagePicture(meta: unknown): boolean {
  const m = (meta ?? {}) as { store_line_image?: unknown; catalog_image_from?: unknown };
  return typeof m.store_line_image === "string" && m.store_line_image !== "" && m.catalog_image_from === m.store_line_image;
}

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

  // The catalog picture, once, and only once it is STORED (#4580): an address
  // the server never stored is a search result, not the catalog picture, or
  // the CATALOG panel shows a picture the thumbnail cannot ("how do I have it
  // in the one place but not the other?"). It is one of the row's own (a
  // crop, an added photo made primary): that pane is current. It is the web
  // result the strip also shows: that tile is current, since the tile is the
  // picture and the outline is what says "you picked this one" (#2982).
  // Otherwise the stored file gets a pane of its own.
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
  if (!current && catalogFile && catalogUrl) current = webTiles.find((t) => t.url === catalogUrl) ?? null;
  if (!current && catalogFile) {
    // The photo the order email printed beside this line (#5350) says so.
    // The variant's own photo on the store's page (#5719) says so too.
    const printed = orderEmailPicture(row.suggested_metadata);
    const store = !printed && storePagePicture(row.suggested_metadata);
    const pane: RowPicture = printed
      ? { key: `catalog:${catalogFile}`, role: "catalog", fileId: catalogFile, url: catalogUrl, thumbUrl: null, caption: "From the order email", current: false, source: "the order email" }
      : store
        ? { key: `catalog:${catalogFile}`, role: "catalog", fileId: catalogFile, url: catalogUrl, thumbUrl: null, caption: "From the store's page", current: false, source: "the store's page" }
        : { key: `catalog:${catalogFile}`, role: "catalog", fileId: catalogFile, url: catalogUrl, thumbUrl: null, caption: "Catalog image", current: false };
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

/** The catalog pane's caption: the picture's ROLE (it is the catalog
 *  picture) and, when it is one of the row's own or a web pick, where it
 *  came from. "Catalog" over a household photo read as a claim that the
 *  photo came from a catalog (#3071); a person's own photo can be the
 *  catalog picture, and the caption says both. */
export function catalogCaption(pictures: readonly RowPicture[]): string {
  const cur = currentPicture(pictures);
  if (!cur) return "Catalog";
  switch (cur.role) {
    case "own":
      return "Catalog: your photo";
    case "crop":
      return cur.cropOf === "screenshot" ? "Catalog: from your screenshot" : "Catalog: your crop";
    case "group":
      return "Catalog: the group photo";
    case "extra":
      return "Catalog: your added photo";
    case "web":
      return cur.source ? `Catalog: from ${cur.source}` : "Catalog: from the web";
    case "catalog":
      return cur.source ? `Catalog: from ${cur.source}` : "Catalog";
    default:
      return "Catalog";
  }
}

/** Where a row says its catalog picture could not be stored, and the words
 *  the card says it with (#4580). The server writes it; every surface reads
 *  it through `catalogUnsaved`. */
export const CATALOG_UNSAVED_KEY = "catalog_image_unsaved";
export const COULDNT_SAVE_WORDS = "Couldn't save this one";

export interface CatalogUnsaved {
  url: string;
  why: string;
  at: string;
}

/** The catalog picture that was let go because it could not be stored, while
 *  nothing has replaced it. */
export function catalogUnsaved(row: { catalog_image_file_id: string | null; suggested_metadata?: unknown }): CatalogUnsaved | null {
  if (row.catalog_image_file_id) return null;
  const meta = row.suggested_metadata;
  if (!meta || typeof meta !== "object") return null;
  const v = (meta as Record<string, unknown>)[CATALOG_UNSAVED_KEY];
  if (!v || typeof v !== "object") return null;
  const u = v as Partial<CatalogUnsaved>;
  return typeof u.url === "string" ? { url: u.url, why: typeof u.why === "string" ? u.why : COULDNT_SAVE_WORDS, at: typeof u.at === "string" ? u.at : "" } : null;
}
