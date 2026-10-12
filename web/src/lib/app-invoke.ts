// The request a custom app's write becomes. A photo the app took (the
// Cataloging Bench's photo box) travels WITH the action as its document, the
// way a person's upload does, so the record the action makes keeps it (#5922).
// Only a picture: the door an app is given attaches photos, not any file.

export const APP_PHOTO_MAX_BYTES = 25 * 1024 * 1024;

export interface AppInvokeBody {
  actionId: string;
  entityKind: string;
  entityId: string;
  args?: Record<string, unknown>;
}

export function appInvokeRequest(
  body: AppInvokeBody,
  photo: unknown,
  photoName: unknown,
): { json: string } | { form: FormData } | { error: string } {
  if (photo == null) return { json: JSON.stringify(body) };
  if (!(photo instanceof Blob) || !photo.type.startsWith("image/")) return { error: "An app can send a photo with an action, and only a photo." };
  if (photo.size === 0 || photo.size > APP_PHOTO_MAX_BYTES) return { error: "That photo is empty or larger than 25 MB." };
  const form = new FormData();
  form.set("payload", JSON.stringify(body));
  const ext = photo.type.split("/")[1]?.replace(/[^a-z0-9]/gi, "") || "png";
  form.set("file", photo, typeof photoName === "string" && photoName.trim() ? photoName.trim().slice(0, 120) : `photo.${ext}`);
  return { form };
}
