// An editable entity thumbnail: click to replace the photo (upload), optionally
// re-fetch the auto image, or remove it. Wraps the read-only EntityThumb with a
// hover "Change" overlay + a hidden file input, so any detail modal can let the
// user re-select an image instead of being stuck with whatever auto-loaded.
//
// Generic + web-side (imports EntityThumb from platform-web, never edits it).
// `onChange(imagePath|null)` is the single write seam — the caller PATCHes the
// entity. `onAutoFetch` is optional (only entities with an auto-image flow, e.g.
// machines, pass it).

import { useRef, useState } from "react";
import { EntityThumb, useImageSrc, useToast } from "@cobblr/platform-web";
import { api, ApiError } from "../lib/api";

export function EntityImageEdit({
  slug,
  src,
  alt,
  size = 96,
  fit = "cover",
  onChange,
  onAutoFetch,
  autoBusy,
  className,
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
  className?: string;
}) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const toast = useToast();
  // `contain` needs the raw resolved src (internal /api/v1 urls are bearer-
  // fetched to a blob: by this hook) because it renders its own <img> instead
  // of the square EntityThumb tile.
  const containSrc = useImageSrc(fit === "contain" ? src : null);

  async function pick(file: File) {
    if (!file.type.startsWith("image/")) {
      toast.error("Pick an image file.");
      return;
    }
    setUploading(true);
    try {
      const f = await api.uploadFile(slug, file);
      onChange(api.fileRawUrl(slug, f.id, "medium"));
      toast.success("Photo updated.");
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : "Upload failed.");
    } finally {
      setUploading(false);
    }
  }

  const busy = uploading || autoBusy;
  return (
    <div className={"shrink-0 " + (className ?? "")}>
      <button
        type="button"
        onClick={() => fileRef.current?.click()}
        disabled={busy}
        title="Change photo"
        className="relative group block rounded overflow-hidden disabled:cursor-wait"
        // contain: fix only the WIDTH so the height follows the image's own
        // ratio. A missing image still falls back to the square placeholder
        // tile (the initial-letter chip needs a box to sit in).
        style={fit === "contain" && containSrc ? { width: size } : { width: size, height: size }}
      >
        {fit === "contain" && containSrc ? (
          <img
            src={containSrc}
            alt={alt}
            className="w-full h-auto object-contain rounded ring-1 ring-line dark:ring-slate-700"
          />
        ) : (
          <EntityThumb src={src} alt={alt} size={size} className="ring-1 ring-line dark:ring-slate-700" />
        )}
        <span className="absolute inset-0 flex items-center justify-center bg-black/45 text-white text-[10px] font-mono uppercase tracking-wide opacity-0 group-hover:opacity-100 transition-opacity">
          {uploading ? "Uploading…" : "Change"}
        </span>
      </button>
      <input
        ref={fileRef}
        type="file"
        accept="image/*"
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) void pick(f);
          e.target.value = "";
        }}
      />
      <div className="flex justify-center gap-2 mt-1">
        {onAutoFetch && (
          <button type="button" onClick={onAutoFetch} disabled={busy} className="text-[10px] text-accent hover:underline disabled:opacity-50">
            {autoBusy ? "Finding…" : "Auto"}
          </button>
        )}
        {src && (
          <button type="button" onClick={() => onChange(null)} disabled={busy} className="text-[10px] text-muted dark:text-slate-400 hover:underline disabled:opacity-50">
            Remove
          </button>
        )}
      </div>
    </div>
  );
}
