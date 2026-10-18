// A record's photos, in the order every photo section shows them: its main
// photo first, then every other picture attached to it.
//
// The core-files attachments list answers with `items` (what is attached) and
// `main` (the record's own image_path, read off the record). The two disagree
// whenever the main photo was never attached: set before photos were kept, a
// catalog match, an address pasted in. A section that read only `items` said
// "No photos yet" above the photo the next section showed (#7335), so every
// section builds its strip here, and a lint holds them to it.
import type { PhotoSource } from "@cobblr/platform-contract/photo-source";

export interface RecordMainPhoto {
  image_path: string;
  file_id: string | null;
  attached: boolean;
  filename: string | null;
  photo_source: PhotoSource | null;
}

export interface RecordAttachmentLike {
  id: string;
  file_id: string;
  filename: string;
  kind: string;
  mime_type?: string;
  photo_source?: PhotoSource | null;
}

export interface RecordPhoto<A extends RecordAttachmentLike> {
  key: string;
  /** The core-files file, when the picture is one; null for an outside address. */
  fileId: string | null;
  /** The address to show when there is no file. */
  imagePath: string | null;
  filename: string;
  source: PhotoSource | null;
  /** The attachment row, when the picture is attached (and so can be taken off). */
  attachment: A | null;
  isMain: boolean;
}

export function isImageAttachment(a: RecordAttachmentLike): boolean {
  return a.kind === "image" || !!a.mime_type?.startsWith("image/");
}

export function recordPhotos<A extends RecordAttachmentLike>(
  list: { main?: RecordMainPhoto | null; items: A[] } | null | undefined,
): RecordPhoto<A>[] {
  if (!list) return [];
  const images = list.items.filter(isImageAttachment);
  const main = list.main ?? null;
  const mainAtt = main?.file_id ? images.find((a) => a.file_id === main.file_id) : undefined;
  const photos: RecordPhoto<A>[] = [];
  if (main) {
    photos.push({
      key: mainAtt?.id ?? "main",
      fileId: main.file_id,
      imagePath: main.file_id ? null : main.image_path,
      filename: mainAtt?.filename ?? main.filename ?? "Main photo",
      source: mainAtt?.photo_source ?? main.photo_source ?? null,
      attachment: mainAtt ?? null,
      isMain: true,
    });
  }
  for (const a of images) {
    if (a === mainAtt) continue;
    photos.push({ key: a.id, fileId: a.file_id, imagePath: null, filename: a.filename, source: a.photo_source ?? null, attachment: a, isMain: false });
  }
  return photos;
}

/** Where to fetch a photo: its core-files file (in a size), or its address. */
export function recordPhotoUrl(filesBase: string, p: Pick<RecordPhoto<RecordAttachmentLike>, "fileId" | "imagePath">, variant?: "thumb" | "medium"): string {
  if (p.fileId) return `${filesBase}/files/${p.fileId}/raw${variant ? `?variant=${variant}` : ""}`;
  return p.imagePath ?? "";
}
