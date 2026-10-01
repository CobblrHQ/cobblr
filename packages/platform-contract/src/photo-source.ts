// Where a photo came from, stored on the file when it is written and never
// guessed afterwards (from a filename, an address, a role). A record's photo
// strip and the scan inbox both say it in the same two words: a picture
// someone took or uploaded is "Your photo"; one from the web, a barcode
// catalog or AI Pick is a "Catalog photo". A file written before this was
// stored has no source, and shows no badge rather than a guess.

export const PHOTO_SOURCE_KINDS = ["camera", "upload", "web", "catalog", "ai_pick"] as const;
export type PhotoSourceKind = (typeof PHOTO_SOURCE_KINDS)[number];

export interface PhotoSource {
  kind: PhotoSourceKind;
  /** The picture's own address, for a picture fetched from the web. */
  original_url?: string | null;
  /** The page it was found on. */
  source_page?: string | null;
  /** What was searched to find it. */
  query?: string | null;
  /** Why AI Pick chose it, in the AI's words. */
  reason?: string | null;
  /** When it was written. */
  at: string;
}

export function isPhotoSourceKind(v: unknown): v is PhotoSourceKind {
  return typeof v === "string" && (PHOTO_SOURCE_KINDS as readonly string[]).includes(v);
}

/** A stored source, read back from a file's metadata. Anything else is no
 *  source: an old file, or a bag someone else wrote. */
export function photoSourceOf(metadata: unknown): PhotoSource | null {
  const s = (metadata as { photo_source?: unknown } | null | undefined)?.photo_source as Partial<PhotoSource> | undefined;
  if (!s || !isPhotoSourceKind(s.kind) || typeof s.at !== "string") return null;
  return s as PhotoSource;
}

/** The two words a person reads: their own picture, or one from a catalog. */
export function photoSourceLabel(kind: PhotoSourceKind): "Your photo" | "Catalog photo" {
  return kind === "camera" || kind === "upload" ? "Your photo" : "Catalog photo";
}
