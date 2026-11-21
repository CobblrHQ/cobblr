// An editable entity thumbnail. A record's photo opens in the shared viewer
// (#4319), where "Change photo" replaces it; with no photo yet, a tap adds
// one (the camera on a phone, usePhotoPick, the file picker elsewhere). Under
// it: Change, Auto (re-fetch the auto image, when the kind has one) and
// Remove, so replacing a photo is still one tap.
//
// Generic + web-side (imports EntityPhoto from platform-web, never edits it).
// `onChange(imagePath|null)` is the single write seam — the caller PATCHes the
// entity. `onAutoFetch` is optional (only entities with an auto-image flow, e.g.
// machines, pass it).

import { useState } from "react";
import { EntityPhoto, KeptPhotoNote, Lightbox, lostConnection, useKeptPhotos, usePhotoPick, useToast } from "@cobblr/platform-web";
import { api, ApiError, getToken } from "../lib/api";

export function EntityImageEdit({
  slug,
  src,
  alt,
  size = 96,
  fit = "cover",
  onChange,
  onAutoFetch,
  autoBusy,
  suggested = false,
  className,
  keptKey,
}: {
  slug: string;
  src?: string | null;
  alt: string;
  size?: number;
  /** How the image fills its box. `cover` (default) is the square tile every
   *  list/detail has used. `contain` keeps the image's OWN proportions at
   *  `size` wide with the height following — for records whose image IS the
   *  identity (a book jacket, a film poster, a bottle label), where a square
   *  crop cuts the top and bottom off the very thing you're looking at. */
  fit?: "cover" | "contain";
  /** New image_path (a core-files raw URL), or null to clear. */
  onChange: (imagePath: string | null) => void;
  /** Re-run the entity's auto-image fetch, if it has one. */
  onAutoFetch?: () => void;
  autoBusy?: boolean;
  /** `src` is a picture the platform found, not the record's own: marked as
   *  a suggestion, and there is nothing of the record's to Remove. */
  suggested?: boolean;
  className?: string;
  /** Where a photo that could not be sent is kept until it lands: the record,
   *  e.g. "part:42". Without it the record's name stands in. */
  keptKey?: string;
}) {
  const [viewing, setViewing] = useState(false);
  const { send, uploading } = usePhotoUpload(slug, onChange);
  // A photo chosen offline is kept and sent when the connection is back,
  // never dropped (#4115, useKeptPhotos).
  const toast = useToast();
  const kept = useKeptPhotos(`${slug}:cover:${keptKey ?? alt}`, send, { one: true, token: getToken() });
  const pick = (file: File) => {
    if (file.type.startsWith("image/")) void kept.send(file);
    else toast.error("Pick an image file.");
  };

  const photo = usePhotoPick((files) => files[0] && void pick(files[0]), { title: `Photo of ${alt}`, label: `Choose a photo of ${alt}` });
  const busy = uploading || kept.busy || autoBusy;
  return (
    <div className={"shrink-0 " + (className ?? "")}>
      <button
        type="button"
        onClick={src ? () => setViewing(true) : photo.pick}
        disabled={busy}
        title={src ? `See ${alt}` : "Add a photo"}
        aria-label={src ? `See the photo of ${alt}` : `Add a photo of ${alt}`}
        className="relative group block rounded overflow-hidden disabled:cursor-wait"
        // One square box whatever the photo: `contain` shows the whole label
        // inside it rather than letting the picture set the header's height.
        style={{ width: size, height: size }}
      >
        <EntityPhoto src={src} alt={alt} size={size} fit={fit === "contain" ? "contain" : "cover"} eager className="rounded ring-1 ring-line dark:ring-slate-700">
          {suggested && (
            <>
              <span className="pointer-events-none absolute inset-1 rounded border-2 border-dashed border-accent/70" />
              <span data-testid="photo-suggested" className="pointer-events-none absolute left-1.5 top-1.5 rounded bg-accent px-1.5 py-0.5 text-[10px] font-medium text-white">
                Suggested
              </span>
            </>
          )}
        </EntityPhoto>
        {/* TOUCH-OK: a caption overlay on a tile that is itself the button:
            tapping the image opens it, so nothing is unreachable. */}
        <span className="absolute inset-0 flex items-center justify-center bg-black/45 text-white text-[10px] uppercase tracking-wide opacity-0 group-hover:opacity-100 transition-opacity">
          {uploading || kept.busy ? "Uploading…" : src ? "View" : "Add"}
        </span>
      </button>
      {photo.input}
      <KeptPhotoNote kept={kept} />
      {viewing && src && (
        <Lightbox
          items={[{ key: src, caption: alt, src, original: src.includes("variant=medium") ? src.replace("variant=medium", "variant=original") : src }]}
          index={0}
          onClose={() => setViewing(false)}
          tools={[
            {
              label: "Change photo",
              busy,
              onAction: () => {
                setViewing(false);
                photo.pick();
              },
            },
          ]}
        />
      )}
      <div className="flex justify-center gap-2 mt-1">
        {src && (
          <button type="button" onClick={photo.pick} disabled={busy} className="text-[10px] text-accent hover:underline disabled:opacity-50">
            Change
          </button>
        )}
        {onAutoFetch && (
          <button type="button" onClick={onAutoFetch} disabled={busy} className="text-[10px] text-accent hover:underline disabled:opacity-50">
            {autoBusy ? "Finding…" : "Auto"}
          </button>
        )}
        {src && !suggested && (
          <button type="button" onClick={() => onChange(null)} disabled={busy} className="text-[10px] text-muted dark:text-slate-400 hover:underline disabled:opacity-50">
            Remove
          </button>
        )}
      </div>
    </div>
  );
}

/** A picture chosen, pasted or dropped onto a record's photo: stored, then
 *  handed to the page's own write as its image_path. One upload, so the photo
 *  box and the web search beside it keep a pasted picture the same way. */
export function usePhotoUpload(slug: string, onChange: (imagePath: string) => void) {
  const [uploading, setUploading] = useState(false);
  const toast = useToast();
  /** Stores it and hands it to the page; throws what went wrong, for a door
   *  that keeps the photo (useKeptPhotos). A refusal is said here; a lost
   *  connection is the kept photo's own note to say. */
  async function send(file: File, key?: string) {
    setUploading(true);
    try {
      const f = await api.uploadFile(slug, file, key ? { idempotencyKey: key } : {});
      onChange(api.fileRawUrl(slug, f.id, "medium"));
      toast.success("Photo updated.");
    } catch (e) {
      if (!lostConnection(e)) toast.error(e instanceof ApiError ? e.message : "Upload failed.");
      throw e;
    } finally {
      setUploading(false);
    }
  }
  async function upload(file: File) {
    if (!file.type.startsWith("image/")) {
      toast.error("Pick an image file.");
      return;
    }
    await send(file).catch(() => {});
  }
  return { upload, send, uploading };
}
